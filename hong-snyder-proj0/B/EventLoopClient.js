const dgram = require('dgram');
const client = dgram.createSocket('udp4');
const crypto = require('crypto');
const readline = require('readline');


// P0P header, message, and state constants
const MAGIC = 0xC461;
const VERSION = 1;
const TIMEOUT = 5000;

const HELLO = 0;
const DATA = 1;
const ALIVE = 2;
const GOODBYE = 3;

const START = 0;
const READY = 1;
const CLOSED = 2;


// Process cmd line args
if (process.argv.length !== 4) {
    console.log('Usage: ./client <hostname> <portnum>');
    process.exit();
}

const host = process.argv[2];
const port = parseInt(process.argv[3]);

// Generate random session ID and initialize state
const sessionId = crypto.randomBytes(4).readUInt32BE(0);
var sequence = 0;
var state = START;

// Send server HELLO and wait for response
sendMessage(HELLO, null);

// Store current timeout timer
var timeout = setTimeout(closeClient, TIMEOUT);

client.on('message', function(msg, rinfo) {
    // Process valid P0P responses, ignore otherwise
    if (state != CLOSED && msg.readUInt16BE(0) == MAGIC && 
            msg.readUInt8(2) == VERSION && msg.readUInt32BE(8) == sessionId) {
        command = msg.readUInt8(3);
        if (command == GOODBYE) {
            // Always close completely on GOODBYE
            process.exit();
        } else if (command == HELLO && state == START) {
            // After HELLO response, begin processing input
            clearTimeout(timeout);
            state = READY;

            var rl = readline.createInterface({
	            input: process.stdin
                // , output: process.stdout
            });

            rl.on('line', function(line) {
                if (line === 'q' && process.stdin.isTTY) {
                    closeClient();
                } else {
                    // console.log("sending: " + line);
                    sendMessage(DATA, line);

                    // Set timer after successful send
                    clearTimeout(timeout);
                    timeout = setTimeout(closeClient, TIMEOUT);
                }
            });

            rl.on('close', function() {
                console.log("eof");
                closeClient();
            });
        } else if (command == ALIVE && state == READY) {
            // Clear timer after server response
            clearTimeout(timeout);
        }
    }
});

// Creates P0P packets and sends them to the server
function sendMessage(command, data) {
    bufSize = 12;
	if (data !== null) {
		bufSize += Buffer.byteLength(data);
	}

	message = Buffer.alloc(bufSize);
    message.writeUInt16BE(MAGIC, 0);
    message.writeUInt8(VERSION, 2);
    message.writeUInt8(command, 3);
    message.writeUInt32BE(sequence, 4)
    sequence++;
    message.writeUInt32BE(sessionId, 8);

    if (data !== null) {
        message.write(data, 12)
    }

    client.send(message, port, host);
}

function closeClient() {
    state = CLOSED;
    sendMessage(GOODBYE, null);
    // Small wait to ensure GOODBYE is sent
    setTimeout(process.exit, 50);
}

