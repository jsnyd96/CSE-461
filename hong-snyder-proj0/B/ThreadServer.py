import socket
import sys
import threading
import struct
from collections import deque


def main():
    if len(sys.argv) < 2:
        print "Usage: ./server <portnum>"
        sys.exit()
    else:
        port = eval(sys.argv[1])

    # Create and bind socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("", port))
    print "Waiting on port " + str(port) + "..."

    # Spawn session management thread
    server = SessionManager(sock, port)
    server.start()

    # Main thread waits for keyboard input (shutdown)
    while True:
        try:
            input = raw_input("")
            if input == "q":
                close_server(server)
        except EOFError:
            close_server(server)


# Close all sessions and quit server
def close_server(server):
    for s_id in server.sessions:
        server.sessions[s_id].close()
        server.sessions[s_id].join()
    server.stop()
    server.sock.close()
    server.join()
    sys.exit()


class SessionManager(threading.Thread):
    SERVER_COMMAND_HELLO   = 0
    SERVER_COMMAND_DATA    = 1
    SERVER_COMMAND_ALIVE   = 2
    SERVER_COMMAND_GOODBYE = 3

    def __init__(self, sock, port):
        self.running = True
        self.sock = sock
        self.port = port
        self.lock = threading.Lock()
        self.seq = 0 # count of all server sends
        self.sessions = {}
        threading.Thread.__init__(self)

    def run(self):
        while self.running:
            # wait for packet, pass to appropriate session
            data, addr = self.sock.recvfrom(1024)

            # message must include 12 byte header, ignore otherwise
            if len(data) >= 12:
                header = struct.unpack("!3I", data[:12])
                magic = header[0] >> 16
                version = (header[0] >> 8) & 0xFF
                command = header[0] & 0xFF
                sequence = header[1]
                s_id = header[2]

                # print "magic =", magic
                # print "version =", version
                # print "command =", command
                # print "sequence =", sequence
                # print "session =", hex(s_id)
                # print data[12:]

                # discard invalid P0P messages
                if magic != 0xC461 or version != 1:
                    continue

                # create new session for new ids
                if s_id not in self.sessions:
                    self.sessions[s_id] = Session(self, addr, s_id)
                    self.sessions[s_id].start()
                    
                # hand packet to session
                self.sessions[s_id].receive((command, sequence, data[12:]))

        print "SERVER SHUTDOWN"

    def get_seq(self):
        self.lock.acquire()
        seq = self.seq
        self.seq += 1
        self.lock.release()
        return seq

    def stop(self):
        self.running = False
        self.sock.sendto("QUIT", ("localhost", self.port))


class Session(threading.Thread):
    SESSION_STATE_NEW     = 0  # waiting for hello
    SESSION_STATE_WAITING = 1  # waiting for data
    SESSION_STATE_DONE    = 2  # closed session
    SESSION_TIMEOUT = 5.0      # 5 second timeout

    def __init__(self, server, addr, session_id):
        self.server = server
        self.addr = addr
        self.s_id = session_id
        self.seq = 0 # next expected sequence number
        self.state = self.SESSION_STATE_NEW
        self.messages = deque()
        threading.Thread.__init__(self)

    def run(self):
            t = self.start_timeout()
            while self.state < self.SESSION_STATE_DONE:
                # spin until next packet is ready
                if not self.messages:
                    continue

                t.cancel()
                message = self.messages.popleft()
                command = message[0]
                sequence = message[1]
                data = message[2]

                # print "Session received message", command, sequence, data

                # process the parsed packet
                if sequence > self.seq:
                    # lost packet(s)
                    while self.seq < sequence:
                        self.display(self.seq, "Lost packet!")
                        self.seq += 1
                elif sequence == self.seq - 1:
                    # duplicate packet
                    self.display(sequence, "Received duplicate packet.")
                    t = self.start_timeout()
                    continue                        
                elif sequence < self.seq:
                    # out of order
                    self.display(sequence, "Protocol error, packet out of order.")
                    self.close()
                    continue

                # packet sequence number matches expected
                if self.state == self.SESSION_STATE_NEW and command == self.server.SERVER_COMMAND_HELLO:
                    # hello on new session
                    self.display(sequence, "Session created.")
                    self.respond(self.server.SERVER_COMMAND_HELLO)
                    self.state = self.SESSION_STATE_WAITING
                elif self.state == self.SESSION_STATE_WAITING and command == self.server.SERVER_COMMAND_DATA:
                    # received data
                    self.display(sequence, data)
                    self.respond(self.server.SERVER_COMMAND_ALIVE)
                elif self.state == self.SESSION_STATE_WAITING and command == self.server.SERVER_COMMAND_GOODBYE:
                    # received goodbye
                    self.display(sequence, "GOODBYE from client.")
                    self.close()
                    continue
                else:
                    # protocol error
                    self.display(sequence, "Protocol error, bad state.")
                    self.close()
                    continue

                self.seq += 1
                if not self.messages:
                    t = self.start_timeout()

            t.cancel()
            self.respond(self.server.SERVER_COMMAND_GOODBYE)
            print hex(self.s_id), "Session closed."
           
    # Gives the message to this session, to be used by SessionManager 
    def receive(self, message):
        self.messages.append(message)

    # Prints output
    def display(self, sequence, text):
        print hex(self.s_id), '[' + str(sequence) +']', text

    # Sends a P0P message to the client with the given command
    def respond(self, command):
        seq = self.server.get_seq()
        self.server.sock.sendto(struct.pack("!3I", (0xC461 << 16) | (1 << 8) | command, seq, self.s_id), self.addr)
        # print '[' + str(seq) + ']', "Server sent command", command, "to session", hex(self.s_id)

    # Creates a timer that closes the session unless cancelled
    def start_timeout(self):
        t = threading.Timer(self.SESSION_TIMEOUT, self.timeout)
        t.start()
        return t

    def timeout(self):
        print hex(self.s_id), "Session timeout."
        self.close()

    def close(self):
        self.state = self.SESSION_STATE_DONE




if __name__ == "__main__":
    main()




