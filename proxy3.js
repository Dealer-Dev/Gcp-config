/*
* Proxy Bridge
* Copyright Dealer Services
* Dedicated to Dealer, for giving me the idea to make this :v
*/
const crypto = require("crypto");
const net = require('net');
const https = require("https");
const stream = require('stream');
const util = require('util');

var dealerKey = process.env.KEY_DEALER || "";

const backends = {
    "/dealer": process.env.IP || "",
    "/dealer1": process.env.IP_1 || "",
    "/dealer2": process.env.IP_2 || "",
    "/dealer3": process.env.IP_3 || ""
};

var mainPort = process.env.PORT || 8080;

var outputFile = "outputFile.txt";
var packetsToSkip = process.env.PACKSKIP || 1;
var gcwarn = true;
for(c = 0; c < process.argv.length; c++) {
    switch(process.argv[c]) {
        case "-skip":
            packetsToSkip = process.argv[c + 1];
            break;
        case "-mport":
            mainPort = process.argv[c + 1];
            break;
        case "-o":
            outputFile = process.argv[c + 1];
            break;
    }
}
function gcollector() {
    if(!global.gc && gcwarn) {
        console.log("[WARNING] Garbage Collector isn't enabled! Memory leaks may occur.");
        gcwarn = false;
        return;
    } else if(global.gc) {
        global.gc();
        return;
    } else {
        return;
    }
}
function parseRemoteAddr(raddr) {
    if(raddr.toString().indexOf("ffff") != -1) {
        //is IPV4 address
        return raddr.substring(7, raddr.length);
    } else {
        return raddr;
    }
}
function validateDealerKey(callback) {

    if (!dealerKey) {
        console.log("[ERROR] KEY_DEALER no configurada.");
        process.exit(1);
    }

    const url =
        "https://dealerbotgenkeys.mcmilton235.workers.dev/validate?key=" +
        encodeURIComponent(dealerKey) +
        "&client=cloudrun";

    https.get(url, (res) => {

        let body = "";

        res.on("data", chunk => {
            body += chunk;
        });

        res.on("end", () => {

            try {

                const result = JSON.parse(body);

                if (result.valid === true) {

                    console.log("[INFO] KEY_DEALER válida.");
                    callback();

                } else {

                    console.log("[ERROR] KEY_DEALER inválida.");
                    process.exit(1);

                }

            } catch (e) {

                console.log("[ERROR] No fue posible validar KEY_DEALER.");
                process.exit(1);

            }

        });

    }).on("error", () => {

        console.log("[ERROR] No fue posible conectar con Script Dealer.");
        process.exit(1);

    });

}
function getBackend(request) {

    const firstLine = request.toString().split("\r\n")[0];

    const match = firstLine.match(/^GET\s+([^\s]+)\s+/);

    if (!match) {
        return null;
    }

    const route = match[1];

    if (!backends[route]) {
        return null;
    }

    const target = backends[route].trim();

    if (!target) {
        return null;
    }

    const parts = target.split(":");

    if (parts.length != 2) {
        return null;
    }

    return {
        route: route,
        host: parts[0],
        port: parseInt(parts[1], 10)
    };

}
setInterval(gcollector, 1000);
validateDealerKey(function () {

const server = net.createServer();

server.on('connection', function(socket) {
    var packetCount = 0;
    //var handshakeMade = false;
    socket.write("HTTP/1.1 101 vip7 Protocols\r\nConnection: Upgrade\r\nDate: " + new Date().toUTCString() + "\r\nSec-WebSocket-Accept: " + Buffer.from(crypto.randomBytes(20)).toString("base64") + "\r\nUpgrade: websocket\r\nServer: p7ws/0.1a\r\n\r\n");
    console.log("[INFO] Connection received from " + socket.remoteAddress + ":" + socket.remotePort);

    var conn = null;
    var selectedBackend = null;

    socket.on('data', function(data) {

    if (!conn) {

        selectedBackend = getBackend(data);

        if (!selectedBackend) {

            console.log("[ERROR] Backend inexistente.");
            socket.destroy();
            return;

        }

        console.log("[INFO] Backend: " + selectedBackend.route);
        console.log("[INFO] Destino: " + selectedBackend.host + ":" + selectedBackend.port);

        conn = net.createConnection({
            host: selectedBackend.host,
            port: selectedBackend.port
        });

        conn.on('data', function(data) {
            socket.write(data);
        });

        conn.on('error', function(error) {
            console.log("[REMOTE] read " + error);
            socket.destroy();
        });

        conn.on('connect', function() {

            conn.write(data);

        });

        return;

    }

    if(packetCount < packetsToSkip) {

        packetCount++;

    } else if(packetCount == packetsToSkip) {

        conn.write(data);

    }

    if(packetCount > packetsToSkip) {

        packetCount = packetsToSkip;

    }

});


    socket.on('error', function(error) {
        console.log("[SOCKET] read " + error + " from " + socket.remoteAddress + ":" + socket.remotePort);
        if (conn) {
    conn.destroy();
}
    });

    socket.on('close', function() {
        console.log("[INFO] Connection terminated for " + socket.remoteAddress + ":" + socket.remotePort);
        if (conn) {
    conn.destroy();
}
    });
});
    
server.listen(mainPort, function(){

    console.log("[INFO] Server started on port: " + mainPort);

    console.log("[INFO] Backend /dealer  : " + (backends["/dealer"] || "No configurado"));
    console.log("[INFO] Backend /dealer1 : " + (backends["/dealer1"] || "No configurado"));
    console.log("[INFO] Backend /dealer2 : " + (backends["/dealer2"] || "No configurado"));
    console.log("[INFO] Backend /dealer3 : " + (backends["/dealer3"] || "No configurado"));

});

});
