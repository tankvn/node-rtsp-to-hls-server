# node-rtsp-to-hls-server
Resteam VOD RTSP to seekable HLS using Node and ffmpeg  
Only for VOD streams and therefore stream must have a total duration.  
Doesn't support live streams.
<br />
<br />
## Install
```
npm install
```
  
## Test stream
1. Change rtsp_transport from "udp" to "tcp" in index.js:68
2. ```node index.js```
3. ```vlc http://0.0.0.0:8000/watch.m3u8?url=rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mov```
