# node-rtsp-to-hls-server
Resteam VOD RTSP to seekable HLS using Node and ffmpeg  
Only for VOD streams and therefore the input stream must have a total duration.  
Doesn't support live streams.  
Using https://github.com/kono0514/FFmpeg-custom-segmenter
<br />
<br />
## Install
```
git lfs install
git clone https://github.com/kono0514/node-rtsp-to-hls-server.git
npm install
```
  
## Test stream
1. Change rtsp_transport from "udp" to "tcp" in index.js
2. ```node index.js```
3. ```mpv http://0.0.0.0:8000/watch.m3u8?url=rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mov```  
or pass the url as a url-encoded filename  
```mpv http://0.0.0.0:8000/rtsp%3A%2F%2Fwowzaec2demo.streamlock.net%2Fvod%2Fmp4%3ABigBuckBunny_115k.mov.m3u8```

## Issues
- Doesn't play smoothly on every player. [#1](https://github.com/kono0514/node-rtsp-to-hls-server/issues/1)  
The current code is doing stream copying (-c:v copy) and using "-break_non_keyframes 1" to keep all segment durations as same as possible.  
This makes output stream doesn't work well on all players. [See break_non_keyframes documentation here](https://www.ffmpeg.org/ffmpeg-formats.html#Options-11)  

| Player   | Status   |
| :------- | :------- |
| MPV | :heavy_check_mark: Works |
| VLC | :heavy_exclamation_mark: Stutters between each segment switch points |
| hls.js | :heavy_check_mark: Works |
| Samsung Tizen TV (AVPlay) | :heavy_check_mark: Works |