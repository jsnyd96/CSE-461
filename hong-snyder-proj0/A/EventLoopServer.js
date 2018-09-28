const MAGIC = 0xC461;
const VERSION = 1;
const HELLO = 0;
const DATA = 1;
const ALIVE = 2;
const GOODBYE = 3;
var serverSeqNum = 0;

const dgram = require('dgram');
const server = dgram.createSocket('udp4');

if (process.argv.length !== 3) {
	console.log('Usage: ./server <portnum>');
	process.exit();
}

var timers = {};

const portnum = parseInt(process.argv[2]);

server.on('listening', function() {
	console.log('Waiting on port ' + server.address().port + '...');
});

// Maps session IDs to objects containing information about specific client
var clients = {};

function createPacket(command, sessionId, data) {
	bufSize = 12;
	if (data !== null) {
		bufSize += Buffer.byteLength(data);
	}
	message = Buffer.alloc(bufSize);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(VERSION, 2);
	message.writeUInt8(command, 3);
	message.writeUInt32BE(serverSeqNum, 4);
	serverSeqNum++;
	message.writeUInt32BE(sessionId, 8);
	
	if (data !== null) {
		message.write(data, 12);
	}
	return message;
}

function serverPrint(sessionId, clientSeqNum, data) {
	console.log('0x' + sessionId.toString(16) + ' [' + clientSeqNum + '] ' + data);
}

function closeClient(sessionId) {
	clearTimeout(timers[sessionId]);
	message = createPacket(GOODBYE, sessionId, null);
	server.send(message, clients[sessionId].clientPort, clients[sessionId].clientAddress);
	console.log('0x' + sessionId.toString(16) + ' Session closed'); 
	delete clients[sessionId];
}

function closeServer() {
	Object.keys(clients).forEach(function(key) {
		closeClient(parseInt(key));
	});
	// Need to set a delay timer here before exiting because node will exit before goodbye messages are sent
	setTimeout(process.exit, 500);
}

const readline = require('readline');
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

rl.on('line', function(line) {
	if (line === 'q') {
		closeServer();
	}
});

rl.on('close', function() {
	closeServer();
});

server.on('message', function(msg, rinfo) {
	// msg is a buffer where every index maps to 1 byte (e.g. msg[0] is first byte of request data
	clientMagic = msg.readUInt16BE(0);
	clientVersion = msg.readUInt8(2);
	clientCommand = msg.readUInt8(3);
	clientSeqNum = msg.readUInt32BE(4);
	clientSessionId = msg.readUInt32BE(8);
	if (clientMagic === MAGIC && clientVersion === VERSION) {
		if (!(clientSessionId in clients)) {
			if (clientCommand === HELLO) {
				clients[clientSessionId] = {
					clientAddress: rinfo.address,
					clientPort: rinfo.port,
					nextSeqNum: clientSeqNum + 1
				};
				response = createPacket(HELLO, clientSessionId, null);
				server.send(response, rinfo.port, rinfo.address);
				serverPrint(clientSessionId, clientSeqNum, 'Session created');
				timers[clientSessionId] = setTimeout(closeClient, 5000, clientSessionId);
			} else {
				// No need to print error, just ignore new non-HELLO packets
				// console.log('Protocol error, shutting down client');
			}
		} else if(clientSeqNum === (clients[clientSessionId].nextSeqNum - 1)) {
			console.log('0x' + clientSessionId.toString(16) + ' Received duplicate packet.');
		} else if(clientSeqNum >= clients[clientSessionId].nextSeqNum) {
			while (clients[clientSessionId].nextSeqNum < clientSeqNum) {
				serverPrint(clientSessionId, clients[clientSessionId].nextSeqNum, 'Lost packet!');
				clients[clientSessionId].nextSeqNum++;
			}
			if (clientCommand === DATA) {
				clearTimeout(timers[clientSessionId]);
				serverPrint(clientSessionId, clientSeqNum, msg.toString('utf8', 12));
				response = createPacket(ALIVE, clientSessionId, null);
				server.send(response, rinfo.port, rinfo.address);
				clients[clientSessionId].nextSeqNum++;
				timers[clientSessionId] = setTimeout(closeClient, 5000, clientSessionId);
			} else if (clientCommand === GOODBYE) {
				serverPrint(clientSessionId, clientSeqNum, 'GOODBYE from client.');
				closeClient(clientSessionId);
			} else {
				console.log('Protocol error, no transition!');
				closeClient(clientSessionId);
			}
		} else {
			console.log('Protocol error, packet out of order!');
			closeClient(clientSessionId);
		}
	}
});

server.bind(portnum);
