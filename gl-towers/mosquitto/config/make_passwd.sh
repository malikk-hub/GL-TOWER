#!/bin/sh
# Creates the broker password file.  Usage: ./make_passwd.sh <api-password> <device-password>
# Device accounts: tower-01 ... tower-08 (add more with: mosquitto_passwd -b passwd tower-09 <pwd>)
set -e
cd "$(dirname "$0")"
rm -f passwd && touch passwd && chmod 640 passwd
mosquitto_passwd -b passwd api "$1"
for i in 01 02 03 04 05 06 07 08; do mosquitto_passwd -b passwd "tower-$i" "$2"; done
echo "passwd file created"
