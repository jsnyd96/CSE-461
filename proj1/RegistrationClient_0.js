const dgram = require('dgram');
const dns = require('dns');
const ip = require('ip');
const readline = require('readline');

const requestSocket = dgram.createSocket('udp4');
const probeSocket = dgram.createSocket('udp4');

requestSocket.bind(0, function() {
	probeSocket.bind(requestSocket.address().port + 1, function() {
		console.log("Registration agent listening on " + requestSocket.address().port +
				", " + probeSocket.address().port +"\n");
		startAgent();
	});
});

var serviceHost = "cse461.cs.washington.edu";
var servicePort = 46101;
var seqNum = 0;

const AGENT_IP = ip.address();
const MAGIC = 0xC461;
const MSG_REGISTER = 0x01;
const MSG_REGISTERED = 0x02;
const MSG_FETCH = 0x03;
const MSG_FETCH_RESPONSE = 0x04;
const MSG_UNREGISTER = 0x05;
const MSG_PROBE = 0x06;
const MSG_ACK = 0x07;

const TIMEOUT = 1000;

var closing = false;

// TODO: The main problem I see now is that if we issue a fetch call in a higher up service using this agent,
// then we have no way of giving the service the set of fetched entries because they're "stuck" in the callback
// that received the message. 

// When a register is sent, this temporarily maps the seqNum of that register to the registration info
// When we get the corresponding registered response back, delete the seqNum entry from this map and put the port in registrations
var registerMap = {}; 
var unregisterMap = {}; // Similar to registerMap, but for unregisters (only keeps the port numbers, not the data or name)
var registrations = {}; // Maps ports to timers set to run registration again based on registration lifetime
var messageInfos = {}; // Maps sequence numbers of outgoing messages to corresponding timers, timeout attempts, and msg type

function timeout(message, request) {
	console.log("Timed out waiting for reply to " + request + " message");
	msgSeqNum = message.readUInt8(2);
	msgInfo = messageInfos[msgSeqNum]; 
	if (msgInfo.attempts < 3) {
		requestSocket.send(message, servicePort, serviceHost);
		msgInfo.attempts++;
		msgInfo.timer = setTimeout(timeout, TIMEOUT, message, request);
	} else {
		delete registerMap[msgSeqNum];
		console.log("Sent 3 " + request + " messages but got no reply.");
		options();
	}
}

// To John: I changed the structure to make each function call sendMessage rather than returning
// messages that we pass to sendMessage. This was done so that the timeout for reregistering would work
// correctly. The timeout callback had to be able to send messages after generating them.
// Note: should probably wait to increment seqNum until after 3xtimeout or
//       server response to facilitate seqNum checking
function sendMessage(message, request) {
	messageType = message.readUInt8(3);
	console.log("Sending " + request + "[" + seqNum + "]...");
	requestSocket.send(message, servicePort, serviceHost);
	msgTimer = setTimeout(timeout, TIMEOUT, message, request);
	messageInfos[seqNum] = { timer: msgTimer, attempts: 1, msgType: messageType };

	// Incrementing seqNum here is fine because messageInfos will carry the old seqNum
	seqNum++;
	if (seqNum > 255) seqNum = 0;
}

function startAgent() {
	requestSocket.on('message', function(msg, rinfo) {
		responseMagic = msg.readUInt16BE(0);
		responseSeqNum = msg.readUInt8(2);
		responseMsgType = msg.readUInt8(3);
		
		if (responseMagic != MAGIC) {
			return;
		}
	
		// This check covers checking to make sure we receive a seqNum
		// that we've been actually waiting for
		if (!(responseSeqNum in messageInfos)) {
			return;
		} else {
			switch(messageInfos[responseSeqNum].msgType) {
				case MSG_REGISTER:
					if (responseMsgType != MSG_REGISTERED) return;
					break;
				case MSG_FETCH:
					if (responseMsgType != MSG_FETCH_RESPONSE) return;
					break;
				case MSG_UNREGISTER:
					if (responseMsgType != MSG_ACK) return;
					break;
				case MSG_PROBE:
					if (responseMsgType != MSG_ACK) return;
					break;
				default:
					return;
			}
		}

		clearTimeout(messageInfos[responseSeqNum].timer);
		if (responseMsgType === MSG_REGISTERED) {
			responseLifetime = msg.readUInt16BE(4);
			
			var regInfo = registerMap[responseSeqNum];
			registrations[regInfo.regPort] = setTimeout(register, responseLifetime * 1000, regInfo.regPort, regInfo.regData, regInfo.regName); 
			delete registerMap[responseSeqNum];		

			console.log("Register successful! Lifetime = " + responseLifetime);
			// Set timer to refresh registration
		} else if (responseMsgType === MSG_FETCH_RESPONSE) {
			numEntries = msg.readUInt8(4);
			entries = []
			for (var i = 0; i < numEntries; i++) {
				// Each entry takes up 10 bytes and the first one starts at pos 5
				startingPos = 5 + (i * 10); 
				entry = {
					entryIp: msg.readUInt32BE(startingPos),
					entryPort: msg.readUInt16BE(startingPos + 4),
					entryData: msg.readUInt32BE(startingPos + 4 + 2)
				}
				entries.push(entry);
			}
			// TODO: Do something with the entries
			// For now, just print them
			entries.forEach(function(item) {
				console.log(ip.fromLong(item.entryIp) + " " + item.entryPort + " " + item.entryData + " (0x" + item.entryData.toString(16) + ")");
			});
		} else if (responseMsgType === MSG_ACK) {
			// console.log("Got ACK!");
			// Delete the registration from registrations (no-op if this ACK was from a probe)
			if (responseSeqNum in unregisterMap) {
				var port = unregisterMap[responseSeqNum];
				clearTimeout(registrations[port]);
				delete registrations[port];
				delete unregisterMap[responseSeqNum];
			}
		}
		options();
	});

	probeSocket.on('message', function(msg, rinfo) {
		responseMagic = msg.readUInt16BE(0);
		responseSeqNum = msg.readUInt8(2);
		responseMsgType = msg.readUInt8(3);
		if (responseMagic === 0xC461 && responseMsgType == MSG_PROBE) {
			console.log('Probe received. Sending ACK.');
			var message = Buffer.alloc(4);
			message.writeUInt16BE(MAGIC, 0);
			message.writeUInt8(responseSeqNum, 2);
			message.writeUInt8(MSG_ACK, 3);
			probeSocket.send(message, rinfo.port, rinfo.address);
		}
	});
}

// Note: If we send a request and don't get an appropritate response within a timeout, resend packet
function register(port, data, name) {
	var message = Buffer.alloc(15 + name.length);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_REGISTER, 3);
	message.writeUInt32BE(ip.toLong(AGENT_IP), 4);
	message.writeUInt16BE(port, 8);
	message.writeUInt32BE(data, 10);
	message.writeUInt8(name.length, 14);
	message.write(name, 15);

	registerMap[seqNum] = { regPort: port, regData: data, regName: name };

	sendMessage(message, "REGISTER");
}

function unregister(port) {
	var message = Buffer.alloc(10);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_UNREGISTER, 3);
	message.writeUInt32BE(ip.toLong(AGENT_IP), 4);
	message.writeUInt16BE(port, 8);

	unregisterMap[seqNum] = port;

	sendMessage(message, "UNREGISTER");

}

function fetch(name) {
	bufSize = 5;
	// Have to dynamically allocate buffer here because name is optional
	nameLength = 0;
	if (name !== null) {
		nameLength = name.length;
	}
	var message = Buffer.alloc(bufSize + nameLength);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_FETCH, 3);
	message.writeUInt8(nameLength, 4);
	if (name !== null) {
		message.write(name, 5);
	}
	sendMessage(message, "FETCH");
}

function probe() {
	var message = Buffer.alloc(4);
	message.writeUInt16BE(MAGIC, 0);
	message.writeUInt8(seqNum, 2);
	message.writeUInt8(MSG_PROBE, 3);
	sendMessage(message, "PROBE");
}

function quit() {
	closing = true;
	// Unregister all current registrations
	Object.keys(registrations).forEach(function(port) {
		clearTimeout(registrations[port]);
		unregister(port);
	});
	// TODO: Wait for a slight bit here to allow unregisters to send
	// TODO: Currently commented out because the timeout results in an error
	//var exit = function() { probeSocket.close(process.exit) };
	//setTimeout(requestSocket.close, 500, exit);
	
	// TODO: Remove this after we get timeout above to work
	requestSocket.close(function() {
		probeSocket.close(process.exit);
	});
}

function options() {
	if (!closing) {
		console.log("");
		console.log("Enter a command:");
		console.log("  Register   - r <portnum> <data> <seviceName>");
		console.log("  Unregister - u <portnum>");
		console.log("  Fetch      - f <prefix>");
		console.log("  Probe      - p");
		console.log("  Quit       - q");
	}
}

if (require.main === module) {
	if (process.argv.length !== 4) {
		console.log('Usage: ./run <service hostname> <service port>');
		process.exit();
	}

	serviceHost = process.argv[2];
	servicePort = parseInt(process.argv[3]);

	dns.lookup(serviceHost, 4, function(err, address, family) {
		console.log("Server IP: " + address);
		console.log("Agent IP: " + AGENT_IP);
		options();
	});
	

	const rl = readline.createInterface({
		input: process.stdin,
	        output: process.stdout
	});

	rl.on('line', function(line) {
		if (line === "q") {
			quit();
		} else if (line.startsWith("r ")) {
			var args = line.split(" ");
			if (args.length == 4) {
				register(args[1], args[2], args[3]);
			}
		} else if (line.startsWith("u ")) {
			var args = line.split(" ");
			if (args.length == 2) {
				unregister(args[1]);
			}
		} else if (line.startsWith("f")) {
			var args = line.split(" ");
			if (args.length === 1) {
				fetch(null);
			} else if (args.length === 2) {
				fetch(args[1]);
			}
		} else if (line === "p") {
			probe();
		} else {
			options();
		}
	});
	
	rl.on('close', function() {
		console.log("eof");
		quit();
	});
}


