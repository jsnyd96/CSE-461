import socket
import threading
import sys
import random
import struct
import time

# Probably need 4 threads: one for server responses, one for user input, one for timeouts, and the main thread used solely for checking if the entire program needs to terminate

current_seq_num = 0

current_session_id = random.getrandbits(32)

connected = False
closing = False
closed = False

timer_lock = threading.Lock()

MAGIC = 0xC461
HEADER_BYTE_SIZE = 96

VERSION_NUM = 1

HELLO = 0
DATA = 1
ALIVE = 2
GOODBYE = 3

if len(sys.argv) < 3:
	print "Usage: ./client <hostname> <portnum>"
	sys.exit()

hostname = sys.argv[1]
portnum = eval(sys.argv[2])
server = (hostname, portnum)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

def create_packet(command, data):
	global current_seq_num
	packet = struct.pack("!3I", (MAGIC << 16) | (VERSION_NUM << 8) | command, current_seq_num, current_session_id)
	current_seq_num += 1
	if data is not None:
		packet += data
	return packet

def parse_header(packet):
	header = struct.unpack("!3I", packet[:HEADER_BYTE_SIZE])
	magic = header[0] >> 16
	version = (header[0] >> 8) & 0xFF
	command = header[0] & 0xFF
	seq_num = header[1]
	server_session_id = header[2]
	return (magic, version, command, seq_num, server_session_id)

def close_client():
	global closing
	sock.sendto(create_packet(GOODBYE, None), server)
	closing = True

def timeout():
	global closed
	close_client()
	closed = True

def create_timer():
	timer = threading.Timer(5, timeout)
	timer.daemon = True
	return timer

def handle_server():
	global connected
	global closing
	global closed
	global timing
	while not closing and not closed:
		packet, addr = sock.recvfrom(1024)
		magic, version, command, seq_num, server_session_id = parse_header(packet)
		if magic == MAGIC and version == VERSION_NUM and server_session_id == current_session_id:
			if command == HELLO and not connected:
				connected = True
			elif command == ALIVE and not closing:
				timer_lock.acquire()
				if timing:
					timer.cancel()
					timing = False
				timer_lock.release()
			elif command == GOODBYE:
				closing = True
				closed = True
			 
def handle_user_input():
	global timer
	global timing
	global closing
	while not closing and not closed:
		try:
			user_input = raw_input("")
			if user_input == "q" and sys.stdin.isatty():
				close_client()
			else:
				message = create_packet(DATA, user_input)
				sock.sendto(message, server)
				timer_lock.acquire()
				if not timing:
					timer = create_timer()
					timer.start()
					timing = True
				timer_lock.release()
				# time.sleep(.01)
		except EOFError:
			print "eof"
			close_client()
				
				
if  __name__ == '__main__':
	global timing
	global timer
	sock.sendto(create_packet(HELLO, None), server)

	timing = True
	timer = create_timer()
	timer.start()
	server_thread = threading.Thread(target = handle_server)
	server_thread.daemon = True
	server_thread.start()
	while not closed:
		if connected:
			timer_lock.acquire()
			if timing:
				timer.cancel()
				timing = False
			timer_lock.release()
			break

	user_input_thread = threading.Thread(target = handle_user_input)
	user_input_thread.daemon = True
	user_input_thread.start()

	while not closed:
		if closing:
			timer_lock.acquire()
			if not timing:
				timing = True
				timer = create_timer()
				timer.start()
			timer_lock.release()
			#Do not set timing - if we receive an alive, we don't want timer to be canceled
			break
	sys.exit()
