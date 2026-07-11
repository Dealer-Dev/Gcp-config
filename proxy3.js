/*
* Proxy Bridge - Multi-Destino (dealer1 / dealer2)
* Copyright PANCHO7532 - P7COMUnications LLC (c) 2021
* Dedicated to Emanuel Miranda, for giving me the idea to make this :v
* Modified for Cloud Run Multi-IP routing by request.
*/
const crypto = require("crypto");
const net = require('net');
const stream = require('stream');
const util = require('util');

// Configuración de destinos mediante Variables de Entorno (Ideales para Cloud Run)
var dhost1 = process.env.DHOST1 || "127.0.0.1";
var dport1 = parseInt(process.env.DPORT1) || 40001;

var dhost2 = process.env.DHOST2 || "127.0.0.1";
var dport2 = parseInt(process.env.DPORT2) || 40002;

var mainPort = process.env.PORT || 8080;
var outputFile = "outputFile.txt";
var gcwarn = true;

// Soporte para argumentos por consola (por si pruebas localmente)
for(let c = 0; c < process.argv.length; c++) {
    switch(process.argv[c]) {
        case "-dhost1":
            dhost1 = process.argv[c + 1];
            break;
        case "-dport1":
            dport1 = parseInt(process.argv[c + 1]);
            break;
        case "-dhost2":
            dhost2 = process.argv[c + 1];
            break;
        case "-dport2":
            dport2 = parseInt(process.argv[c + 1]);
            break;
        case "-mport":
            mainPort = process.env.PORT || process.argv[c + 1];
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
    if(!raddr) return "unknown";
    if(raddr.toString().indexOf("ffff") != -1) {
        return raddr.substring(7, raddr.length);
    } else {
        return raddr;
    }
}

setInterval(gcollector, 1000);

const server = net.createServer();

server.on('connection', function(socket) {
    var handshakeMade = false;
    var conn = null;
    var bufferQueue = []; // Guarda los paquetes del cliente mientras se abre el túnel

    console.log("[INFO] Connection received from " + parseRemoteAddr(socket.remoteAddress) + ":" + socket.remotePort);

    socket.on('data', function(data) {
        // Primer paquete: Leemos el payload para saber a dónde ir
        if(!handshakeMade) {
            const payloadStr = data.toString('utf8');
            let targetHost = dhost1;
            let targetPort = dport1;
            let routeLabel = "dealer1 (Default)";

            // Comprobamos cuál payload se utilizó
            if (payloadStr.includes("GET /dealer2")) {
                targetHost = dhost2;
                targetPort = dport2;
                routeLabel = "dealer2";
            }

            console.log("[ROUTING] Route [" + routeLabel + "] matched. Bridging to -> " + targetHost + ":" + targetPort);

            // Creamos la conexión al destino seleccionado en tiempo real
            conn = net.createConnection({host: targetHost, port: targetPort}, function() {
                // El destino conectó con éxito, procedemos a responder el handshake al cliente
                socket.write("HTTP/1.1 101 vip7 Protocols\r\nConnection: Upgrade\r\nDate: " + new Date().toUTCString() + "\r\nSec-WebSocket-Accept: " + Buffer.from(crypto.randomBytes(20)).toString("base64") + "\r\nUpgrade: websocket\r\nServer: p7ws/0.1a\r\n\r\n");
                
                handshakeMade = true;

                // Despachamos cualquier dato que haya entrado en cola mientras se establecía el puente
                while(bufferQueue.length > 0) {
                    conn.write(bufferQueue.shift());
                }
            });

            // Manejadores de eventos de la conexión remota creados dinámicamente
            conn.on('data', function(remoteData) {
                socket.write(remoteData);
            });

            conn.on('error', function(error) {
                console.log("[REMOTE] read error: " + error.message);
                socket.destroy();
            });

            conn.on('close', function() {
                console.log("[INFO] Remote endpoint closed the connection.");
                socket.destroy();
            });

        } else {
            // Si el túnel ya está establecido, pasamos los datos o los encolamos temporalmente si conn aún no está listo
            if(conn && conn.writable) {
                conn.write(data);
            } else {
                bufferQueue.push(data);
            }
        }
    });

    socket.on('error', function(error) {
        console.log("[SOCKET] read " + error.message + " from " + parseRemoteAddr(socket.remoteAddress) + ":" + socket.remotePort);
        if(conn) conn.destroy();
    });

    socket.on('close', function() {
        console.log("[INFO] Connection terminated for " + parseRemoteAddr(socket.remoteAddress) + ":" + socket.remotePort);
        if(conn) conn.destroy();
    });
});

server.listen(mainPort, function(){
    console.log("[INFO] Multi-Routing Server started on port: " + mainPort);
    console.log("[INFO] Target 1 (dealer1): " + dhost1 + ":" + dport1);
    console.log("[INFO] Target 2 (dealer2): " + dhost2 + ":" + dport2);
});
