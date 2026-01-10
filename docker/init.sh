#!/bin/sh

#backend
cp -r ./docker/backend/* ./backend/

#geoip-data
mkdir -p ./backend/GeoIP/
wget -O ./backend/GeoIP/GeoLite2-City.mmdb https://raw.githubusercontent.com/mempool/geoip-data/master/GeoLite2-City.mmdb
wget -O ./backend/GeoIP/GeoLite2-ASN.mmdb https://raw.githubusercontent.com/mempool/geoip-data/master/GeoLite2-ASN.mmdb

#frontend
localhostIP="127.0.0.1"
cp ./docker/frontend/* ./frontend
cp ./nginx.conf ./frontend/
