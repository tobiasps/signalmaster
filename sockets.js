var socketIO = require('socket.io'),
    uuid = require('node-uuid'),
    crypto = require('crypto');

module.exports = function (server, config) {
    var io = socketIO.listen(server);

    io.sockets.on('connection', function (client) {
        client.resources = {
            screen: false,
            video: true,
            audio: false
        };

        //set nickname
        client.on('nickname', function (nickName) {
            if (!nickName || nickName == client.nickName) return;
            client.nickName = nickName;
            console.log('Client Id:' + client.id + ' sets his name to: ' + nickName);
        });

        //set info
        client.on('setinfo', function (info) {
            //Try to parse in case we have a message from native client

            var infoParsed;
            if (info && typeof info === 'string')
                infoParsed = JSON.parse(info);
            else
                infoParsed = info;

            if (infoParsed) {
                if (infoParsed.nickname)
                    client.nickName = infoParsed.nickname;
                if (infoParsed.mode)
                    client.mode = infoParsed.mode;
                if (infoParsed.strongId)
                    client.strongId = infoParsed.strongId;
            }
            console.log('Client Id:' + client.id + ' changed his info');
        });

        client.on('getroommembers', function () {
            var result = gatherRoomMembers(client.room);
            if (result.clients.length > 0)
                client.emit('roommembers', result);
        });

        // pass a message to another id
        client.on('message', function (details) {
            if (!details) return;

            //Try to parse in case we have a message from native client
            if (!details.to) {
                var result = JSON.parse(details);
                details = result;
            }

            var otherClient = io.to(details.to);
            if (!otherClient) // Maybe strong ID?
            {
                var thisroom = io.sockets.adapter.rooms[client.room];
                if (thisroom) {
                    for (var id in thisroom) {
                        if (io.sockets.adapter.nsp.connected[id].strongId == details.to) {
                            otherClient = io.to(id);
                            break;
                        }
                    }
                }
            }
            if (!otherClient)
                return;

            details.from = client.id;
            details.fromStrongId = client.strongId;
            details.fromNickName = client.nickName;
            details.fromMode = client.mode;
            details.fromRoom = client.room;
            otherClient.emit('message', details);
            console.log('Client Id: ' + client.id + ' sends message to Id: ' + details.to + ' Type: ' + details.type);
        });

        client.on('shareScreen', function () {
            client.resources.screen = true;
        });

        client.on('unshareScreen', function (type) {
            client.resources.screen = false;
            removeFeed('screen');
        });

        client.on('join', join);

        function removeFeed(type) {
            if (client.room) {
                io.sockets.in(client.room).emit('remove', {
                    id: client.id,
                    type: type
                });
                if (!type) {
                    console.log('Client Id: ' + client.id + ' leaves room: ' + client.room);
                    client.leave(client.room);

                    //Inform other peers about leaving
                    io.sockets.in(client.room).emit('memberleaved', {
                        id: client.id,
                        strongId: client.strongId,
                        name: client.nickName,
                        mode: client.mode
                    });

                    var result = gatherRoomMembers(client.room);
                    if (result.clients.length > 0)
                        io.sockets.in(client.room).emit('roommembers', result);

                    client.room = undefined;
                }
            }
        }

        function join(name, cb) {
            // sanity check
            if (typeof name !== 'string') return;
            // check if maximum number of clients reached
            if (config.rooms && config.rooms.maxClients > 0 &&
                clientsInRoom(name) >= config.rooms.maxClients) {
                safeCb(cb)('full');
                return;
            }
            // leave any existing rooms
            if (client.room != name)
                removeFeed();

            safeCb(cb)(null, describeRoom(name));

            //Inform other peers about joining
            io.sockets.in(name).emit('memberjoined', {
                id: client.id,
                strongId: client.strongId,
                name: client.nickName,
                mode: client.mode
            });

            client.join(name);
            client.room = name;

            var result = gatherRoomMembers(client.room);
            if (result.clients.length > 0)
                io.sockets.in(client.room).emit('roommembers', result);

            console.log('Client Id: ' + client.id + ' joins room: ' + name);
        }

        // we don't want to pass "leave" directly because the
        // event type string of "socket end" gets passed too.
        client.on('disconnect', function () {
            removeFeed();
        });
        client.on('leave', function () {
            removeFeed();
        });

        client.on('create', function (name, cb) {
            if (arguments.length == 2) {
                cb = (typeof cb == 'function') ? cb : function () {};
                name = name || uuid();
            } else {
                cb = name;
                name = uuid();
            }
            // check if exists
            var room = io.nsps['/'].adapter.rooms[name];
            if (room && room.length) {
                safeCb(cb)('taken');
            } else {
                console.log('Room created: ' + name);
                join(name);
                safeCb(cb)(null, name);
            }
        });

        // support for logging full webrtc traces to stdout
        // useful for large-scale error monitoring
        client.on('trace', function (data) {
            console.log('trace', JSON.stringify(
            [data.type, data.session, data.prefix, data.peer, data.time, data.value]
            ));
        });


        // tell client about stun and turn servers and generate nonces
        client.emit('stunservers', config.stunservers || []);

        // create shared secret nonces for TURN authentication
        // the process is described in draft-uberti-behave-turn-rest
        var credentials = [];
        // allow selectively vending turn credentials based on origin.
        var origin = client.handshake.headers.origin;
        if (!config.turnorigins || config.turnorigins.indexOf(origin) !== -1) {
            config.turnservers.forEach(function (server) {
                var hmac = crypto.createHmac('sha1', server.secret);
                // default to 86400 seconds timeout unless specified
                var username = Math.floor(new Date().getTime() / 1000) + (server.expiry || 86400) + "";
                hmac.update(username);
                credentials.push({
                    username: username,
                    credential: hmac.digest('base64'),
                    urls: server.urls || server.url
                });
            });
        }
        var conDetails = [client.id, client.handshake.issued + ''];
        client.emit('turnservers', credentials);
        client.emit('loggedin', conDetails);
        console.log('Client Id: ' + client.id + ' Connected to signaling');
    });


    function describeRoom(name) {
        var adapter = io.nsps['/'].adapter;
        var clients = adapter.rooms[name] || {};
        var result = {
            clients: {}
        };
        Object.keys(clients).forEach(function (id) {
            result.clients[id] = adapter.nsp.connected[id].resources;
            result.clients[id].strongId = adapter.nsp.connected[id].strongId;
            result.clients[id].nickName = adapter.nsp.connected[id].nickName;
            result.clients[id].mode = adapter.nsp.connected[id].mode;
        });
        return result;
    }

    function gatherRoomMembers(room) {
        var result = {
            clients: []
        };
        var thisroom = io.sockets.adapter.rooms[room];
        if (thisroom) {
            for (var id in thisroom) {
                var clName = "undefined";
                var clMode = "undefined";
                var clStrongId = "";
                if (io.sockets.adapter.nsp.connected[id].strongId)
                    clStrongId = io.sockets.adapter.nsp.connected[id].strongId;
                if (io.sockets.adapter.nsp.connected[id].nickName)
                    clName = io.sockets.adapter.nsp.connected[id].nickName;
                if (io.sockets.adapter.nsp.connected[id].mode)
                    clMode = io.sockets.adapter.nsp.connected[id].mode;
                result.clients.push({ id: id, strongId: clStrongId, name: clName, mode: clMode });
            }
        }
        return result;
    }

    function clientsInRoom(name) {
        return io.sockets.clients(name).length;
    }

    function emitToAllButMe(name, value) {

        return io.sockets.clients(name).length;
    }
};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () {};
    }
}
