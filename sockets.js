var socketIO = require('socket.io'),
    uuid = require('node-uuid'),
    crypto = require('crypto'),
    winston = require('winston'),
    strftime = require('strftime'),
    sdptransform = require('sdp-transform');

var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({
            timestamp: function () {
                return strftime('%Y-%m-%d %H:%M:%S');
            },
            formatter: function (options) {
                // Return string will be passed to logger.
                return options.timestamp() + ' ' + options.level.toUpperCase() + ': ' +
                    (options.message ? options.message : '') +
                    (options.meta && Object.keys(options.meta).length ? '\n\t' + JSON.stringify(options.meta) : '');
            }
        })
    ]
});

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
            logger.info('Client Id:' + client.id + ' sets his name to: ' + nickName);
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
            logger.info('Client Id:' + client.id + ' changed his info');
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
            try {
                details = prioritizeVideoCodecs(details);
                details = setOpusMaxAvgBitrate(details);
            } catch (e) {
                logger.error(e);
            }
            otherClient.emit('message', details);
            logger.info('Client Id: ' + client.id + ' sends message to Id: ' + details.to + ' Type: ' + details.type);
            // logger.info(details);
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
                    logger.info('Client Id: ' + client.id + ' leaves room: ' + client.room);
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

            logger.info('Client Id: ' + client.id + ' joins room: ' + name);
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
                logger.info('Room created: ' + name);
                join(name);
                safeCb(cb)(null, name);
            }
        });

        // support for logging full webrtc traces to stdout
        // useful for large-scale error monitoring
        client.on('trace', function (data) {
            logger.info('trace', data);
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
        logger.info('Client Id: ' + client.id + ' Connected to signaling');
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

    function prioritizeVideoCodecs(details) {
        var priority = config.codecPriority || [];  // ordered priority list, first = highest priority
        var ids = [];
        Object.keys(priority).forEach(function (key) {
            var id = findCodecId(details, priority[key]);
            if (id) {
                ids.push(id);
            }
        });
        if (ids.length > 0 && details.payload && details.payload.sdp) {
            var sdp = details.payload.sdp;
            var m = sdp.match(/m=video\s(\d+)\s[A-Z\/]+\s([0-9\ ]+)/);
            if (m !== null && m.length == 3) {
                var candidates = m[2].split(" ");
                var prioritized = ids;
                Object.keys(candidates).forEach(function (key) {
                    if (ids.indexOf(candidates[key]) == -1) {
                        prioritized.push(candidates[key]);
                    }
                });
                var mPrioritized = m[0].replace(m[2], prioritized.join(" "));
                logger.info("Setting video codec priority. \"%s\"", mPrioritized);
                details.payload.sdp = sdp.replace(m[0], mPrioritized);
            }
        }
        return details;
    }

    function setOpusMaxAvgBitrate(details) {
        var maxAvgBitRate = config.maxAverageBitRate || 0;
        if (maxAvgBitRate > 0) {
            var id = findCodecId(details, "opus");
            if (id && details.payload && details.payload.sdp) {
                details.payload.sdp = alterFmtpConfig(details.payload.sdp, id, {"maxaveragebitrate": maxAvgBitRate});
            }
        }
        return details;
    }

    function alterFmtpConfig(sdp, id, params) {
        if (sdp.length > 0 && id && Object.keys(params).length > 0) {
            var res = sdptransform.parse(sdp);
            res.media.forEach(function (item) {
                item.fmtp.some(function (fmtp) {
                    if (fmtp.payload == id) {
                        var origParams = sdptransform.parseParams(fmtp.config);
                        Object.keys(params).forEach(function (key) {
                            origParams[key] = params[key];
                        });
                        fmtp.config = writeParams(origParams);
                        logger.info("FMTP for payload " + id + " set to: " + fmtp.config);
                        return true; // break loop
                    } else {
                        return false; // continue loop
                    }
                });
            });
            sdp = sdptransform.write(res);
        }
        return sdp;
    }

    function writeParams(config) {
        var params = [];
        Object.keys(config).forEach(function (key) {
            params.push(key + "=" + config[key]);
        });
        return params.join(";");
    }

    function findCodecId(details, codec) {
        if (details.payload && details.payload.sdp) {
            var pattern = "a=rtpmap\\:(\\d+)\\s" + codec + "\\/\\d+";
            var re = new RegExp(pattern);
            var m = details.payload.sdp.match(re);
            if (m !== null && m.length > 0) {
                return m[1];
            }
        }
        return null;
    }
};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () {};
    }
}
