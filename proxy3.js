/*
* Proxy Bridge - Multi-Destino (dealer1 / dealer2) con Validación de Licencia
* Copyright PANCHO7532 - P7COMUnications LLC (c) 2021
* Dedicated to Emanuel Miranda, for giving me the idea to make this :v
* Modified for Cloud Run Multi-IP routing and license verification.
*/
const crypto = require("crypto");
const net = require('net');
const stream = require('stream');
const util = require('util');
const https = require('https'); // Requerido para validar la clave con el Worker

// Configuración de destinos mediante Variables de Entorno
var dhost1 = process.env.DHOST1 || "127.0.0.1";
var dport1 = parseInt(process.env.DPORT1) || 40001;

var dhost2 = process.env.DHOST2 || "127.0.0.1";
var dport2 = parseInt(process.env.DPORT2) || 40002;

var mainPort = process.env.PORT || 8080;
var outputFile = "outputFile.txt";
var gcwarn = true;

// Requisitos de Validación (Worker & KEY_DEALER)
const KEY_DEALER = process.env.KEY_DEALER;
// CAMBIA ESTO por la URL de tu Cloudflare Worker
const WORKER_URL = "https://tu-worker.workers.dev"; 

// Intentar deducir el dominio run.app dinámicamente desde el entorno de Cloud Run
const RUN_SERVICE = process.env.K_SERVICE || "dealer-service";
const RUN_PROJECT = process.env.GCP_PROJECT || "google-cloud-project";
const RUN_REGION = process.env.K_REVISION ? process.env.K_REVISION.split("-").slice(-2, -1)[0] : "us-central1"; 
var runDomain = `${RUN_SERVICE}-${RUN_PROJECT}.${RUN_REGION}.run.app`;

// Soporte para argumentos por consola (por si pruebas localmente)
for(let c = 0; c < process.argv.length; c++) {
    switch(process.argv[c]) {
        case "-key":
            process.env.KEY_DEALER = process.argv[c + 1];
            break;
        case "-domain":
            runDomain = process.argv[c + 1];
            break;
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

const keyDealerFinal = process.env.KEY_DEALER || KEY_DEALER;

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
    var bufferQueue = []; 

    console.log("[INFO] Connection received from " + parseRemoteAddr(socket.remoteAddress) + ":" + socket.remotePort);

    socket.on('data', function(data) {
        if(!handshakeMade) {
            const payloadStr = data.toString('utf8');
            let targetHost = dhost1;
            let targetPort = dport1;
            let routeLabel = "dealer1 (Default)";

            if (payloadStr.includes("GET /dealer2")) {
                targetHost = dhost2;
                targetPort = dport2;
                routeLabel = "dealer2";
            }

            console.log("[ROUTING] Route [" + routeLabel + "] matched. Bridging to -> " + targetHost + ":" + targetPort);

            conn = net.createConnection({host: targetHost, port: targetPort}, function() {
                socket.write("HTTP/1.1 101 vip7 Protocols\r\nConnection: Upgrade\r\nDate: " + new Date().toUTCString() + "\r\nSec-WebSocket-Accept: " + Buffer.from(crypto.randomBytes(20)).toString("base64") + "\r\nUpgrade: websocket\r\nServer: p7ws/0.1a\r\n\r\n");
                
                handshakeMade = true;

                while(bufferQueue.length > 0) {
                    conn.write(bufferQueue.shift());
                }
            });

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

// Función para validar la licencia contra el Cloudflare Worker antes de encender el proxy
async function checkLicense() {
    if (!keyDealerFinal) {
        console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.error("  ❌ ERROR CRÍTICO: La variable KEY_DEALER no está definida. ");
        console.error("  Debes configurarla en las variables de entorno del servicio.");
        console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        process.exit(1);
    }

    const verificationUrl = `${WORKER_URL}/validate?key=${encodeURIComponent(keyDealerFinal)}&client=cloudrun&domain=${encodeURIComponent(runDomain)}`;
    console.log("[LICENCIA] Validando clave...");

    https.get(verificationUrl, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
            try {
                const parsedData = JSON.parse(rawData);
                if (res.statusCode === 200 && parsedData.valid) {
                    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    console.log("  🟢 LICENCIA AUTORIZADA ");
                    console.log(`  Reseller: ${parsedData.owner}`);
                    console.log(`  Dominio: ${runDomain}`);
                    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    
                    // Si todo es válido, arranca el servidor
                    startServer();
                } else {
                    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    console.error("  ❌ ACCESO DENEGADO ");
                    console.error(`  Razón: ${parsedData.reason || "Llave inválida o ya usada"}`);
                    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    process.exit(1);
                }
            } catch (e) {
                console.error("[LICENCIA] Error procesando respuesta del Worker:", e.message);
                process.exit(1);
            }
        });
    }).on('error', (err) => {
        console.error("[LICENCIA] Fallo al conectar con el Worker de validación:", err.message);
        process.exit(1);
    });
}

function startServer() {
    server.listen(mainPort, function(){
        console.log("[INFO] Multi-Routing Server started on port: " + mainPort);
        console.log("[INFO] Target 1 (dealer1): " + dhost1 + ":" + dport1);
        console.log("[INFO] Target 2 (dealer2): " + dhost2 + ":" + dport2);
    });
}

// Inicialización
checkLicense();
