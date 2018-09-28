import socket
import struct
import random
import threading
import time

UDP_IP = "127.0.0.1"
UDP_PORT = 5005

s_id = random.getrandbits(32)
addr = (UDP_IP, UDP_PORT)

def message(command, seq):
    return struct.pack("!3I", ((int("C461", 16) << 16) + (1 << 8) + command), seq, s_id)

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.sendto(message(0,0), addr)
time.sleep(0.3)
sock.sendto(message(1,1) + "Hello World!", addr)
time.sleep(0.3)
sock.sendto(message(1,3) + "Hello World!", addr)
time.sleep(0.3)
sock.sendto(message(3,4) + "Hello World!", addr)

