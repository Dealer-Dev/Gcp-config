/*
* Proxy Bridge - Multi-Destino (dealer1 al dealer5) con Validación de Licencia
* Modified for Cloud Run Multi-IP routing (Up to 5 IPs) and license verification.
*/
const crypto = require("crypto");
const net = require('net');
const stream = require('stream');
const util = require('util');
const https = require('https'); // Requerido para validar la clave con el Worker

// Configuración dinámica de hasta 5 destinos mediante Variables de Entorno (o valores por defecto)
const destinos = {
    1: { host: process.env.DHOST1 || "127.0.0.1", port: parseInt(process.env.DPORT1) || 40001 },
    2: { host: process.env.DHOST2 || "127.0.0.1", port: parseInt(process.env.DPORT2) || 40002 },
    3: { host: process.env.DHOST3 || "127.0.0.1", port: parseInt(process.env.DPORT3) || 40003 },
    4: { host: process.env.DHOST4 || "127.0.0.1", port: parseInt(process.env.DPORT4) || 40004 },
    5: { host: process.env.DHOST5 || "127.0.0.1", port: parseInt(process.env.DPORT5) || 40005 }
};

var mainPort = process.env.PORT || 8080;
var outputFile = "outputFile.txt";
var gcwarn = true;

// Requisitos de Validación (Worker & KEY_DEALER)
const KEY_DEALER = process.env.KEY_DEALER;
// Tu Cloudflare Worker de validación
const WORKER_URL = "https://dealerbotgenkeys.mcmilton235.workers.dev"; 

// SOLUCIÓN EFICAZ: Usa la variable manual 'MY_RUN_DOMAIN' si existe, de lo contrario intenta deducirla
const RUN_SERVICE = process.env.K_SERVICE || "dealer-service";
const RUN_PROJECT = process.env.GCP_PROJECT || "google-cloud-project";
const RUN_REGION = process.env.K_REVISION ? process.env.K_REVISION.split("-").slice(-2, -1)[0] : "us-central1"; 

var runDomain = process.env.MY_RUN_DOMAIN || `${RUN_SERVICE}-${RUN_PROJECT}.${RUN_REGION}.run.app`;

// Soporte dinámico para argumentos por consola de los 5 destinos (-dhostX y -dportX)
for(let c = 0; c < process.argv.length; c++) {
    const arg = process.argv[c];
    
    if (arg === "-key") {
        process.env.KEY_DEALER = process.argv[c + 1];
    } else if (arg === "-domain") {
        runDomain = process.argv[c + 1];
    } else if (arg === "-mport") {
        mainPort = process.env.PORT || process.argv[c + 1];
    } else if (arg === "-o") {
        outputFile = process.argv[c + 1];
    } else {
        // Mapea automáticamente argumentos como -dhost1, -dport1, ..., -dhost5, -dport5
        for (let i = 1; i <= 5; i++) {
            if (arg === `-dhost${i}`) {
                destinos[i].host = process.argv[c + 1];
            } else if (arg === `-dport${i}`) {
                destinos[i].port = parseInt(process.argv[c + 1]);
            }
        }
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
            
            // Destino por defecto (dealer1)
            let targetHost = destinos[1].host;
            let targetPort = destinos[1].port;
            let routeLabel = "dealer1 (Default)";

            // Comprobamos de forma dinámica cuál de los 5 payloads se utilizó
            for (let i = 2; i <= 5; i++) {
                if (payloadStr.includes(`GET /dealer${i}`)) {
                    targetHost = destinos[i].host;
                    targetPort = destinos[i].port;
                    routeLabel = `dealer${i}`;
                    break;
                }
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
        for (let i = 1; i <= 5; i++) {
            console.log(`[INFO] Target ${i} (dealer${i}): ` + destinos[i].host + ":" + destinos[i].port);
        }
    });
}

// Inicialización
checkLicense();
