/* eslint-disable no-console */
const http = require('http');
const fs = require('fs');
const url = require('url');
const ffmpeg = require('fluent-ffmpeg');
const glob = require('glob');
const uniqueFilename = require('unique-filename');
const path = require('path');
const colors = require('colors/safe');

const enableDebug = true;
const serverPort = 8000;
const transcodePath = 'transcoding-tmp/';
const isWin = process.platform === 'win32';
const selfDestructDuration = 60;
const hlsSegmentDuration = 5;
const hlsSegmentMaxGap = 3;
const maxProcess = 3;
const streams = {};

if (!fs.existsSync(transcodePath)) {
  console.log(colors.cyan(`transcodePath: ${transcodePath} doesn't exist. Creating...`));
  try {
    fs.mkdirSync(transcodePath);
  } catch (err) {
    console.log(colors.red('Create transcodePath failed'));
  }
}

if (isWin) {
  ffmpeg.setFfmpegPath('C://ffmpeg20190519/bin/ffmpeg.exe');
  ffmpeg.setFfprobePath('C://ffmpeg20190519/bin/ffprobe.exe');
}

if (!enableDebug) {
  console.log = function noConsole() {};
}

class Stream {
  constructor(streamUrl, streamIdentifier, seekToSegment, finishCallback) {
    this.streamUrl = streamUrl;
    this.streamIdentifier = streamIdentifier;
    this.seekToSegment = seekToSegment;
    this.process = null;
    this.lastActivity = new Date();
    this.selfDestructTimer = null;
    this.finishCallback = finishCallback;
  }

  spawn(successCallback, errorCallback) {
    console.log(colors.cyan('Starting ffprobe and then ffmpeg:'), this.streamUrl, this.streamIdentifier, `${this.seekToSegment}.ts`);
    this.startSelfDestructor();
    let initialCallbackSent = false;
    // eslint-disable-next-line consistent-return
    ffmpeg.ffprobe(this.streamUrl, ['-user-agent', 'SEI-RTSP'], (probeErr, metadata) => {
      if (probeErr) {
        console.log(colors.red(`ffprobe failed with error (${this.streamIdentifier}):`));
        console.log(probeErr);
        initialCallbackSent = true;
        return errorCallback(probeErr);
      }

      const placeholderM3U8 = Stream.generateM3U8(metadata.format.duration, this.streamIdentifier);
      const outputSegmentPath = path.join(transcodePath, `${this.streamIdentifier}%d.ts`);
      const outputM3u8Path = path.join(transcodePath, `${this.streamIdentifier}.m3u8`);

      const inputOptions = [
        '-rtsp_transport udp',
        '-fflags +genpts',
        '-noaccurate_seek',
        '-max_delay 0',
        '-user-agent SEI-RTSP',
      ];
      if (this.seekToSegment > 0) {
        inputOptions.push(`-ss ${this.seekToSegment * hlsSegmentDuration}`);
      }

      const outputOptions = [
        '-c copy',
        '-f hls',
        /* '-copyts',
        '-avoid_negative_ts disabled',
        '-start_at_zero', */
        '-avoid_negative_ts 1',
        '-vsync 0',
        '-hls_flags +split_by_time+temp_file',
        `-hls_time ${hlsSegmentDuration}`,
        '-hls_segment_type mpegts',
        `-start_number ${this.seekToSegment}`,
        `-hls_segment_filename ${outputSegmentPath}`,
      ];

      this.process = ffmpeg(this.streamUrl);
      this.process.inputOptions(inputOptions).addOptions(outputOptions).output(outputM3u8Path);
      // eslint-disable-next-line consistent-return
      this.process.on('error', (err) => {
        if (!initialCallbackSent) {
          console.log(colors.red(`ffmpeg failed with error (${this.streamIdentifier}):`));
          console.log(err);
          initialCallbackSent = true;
          return errorCallback(err);
        }
        this.process = null;
      });
      // eslint-disable-next-line consistent-return
      this.process.on('start', () => {
        if (!initialCallbackSent) {
          console.log(colors.green(`ffmpeg started successfully (${this.streamIdentifier}):`));
          initialCallbackSent = true;
          return successCallback(placeholderM3U8);
        }
      });
      this.process.on('end', () => {
        console.log(colors.green(`ffmpeg transcode finished (${this.streamIdentifier})`));
        this.kill();
      });
      this.process.run();
      this.lastActivity = new Date();
    });
  }

  kill(remove = false) {
    console.log(colors.cyan(`Killing process manually (${this.streamIdentifier})`));
    clearInterval(this.selfDestructTimer);
    this.selfDestructTimer = null;
    if (this.process != null) {
      this.process.kill();
      this.process = null;
    }
    if (remove) {
      this.removeFiles();
    }
    this.finishCallback();
  }

  removeFiles() {
    console.log(`Removing files (${this.streamIdentifier})`);
    const files = glob.sync(path.join(transcodePath, `${this.streamIdentifier}*`), {});
    for (let i = files.length - 1; i >= 0; i -= 1) {
      fs.unlink(files[i], () => {
        console.log(colors.red(`Error deleting file ${files[i]}`));
      });
    }
  }

  startSelfDestructor() {
    if (this.selfDestructTimer === null) {
      this.selfDestructTimer = setInterval(this.checkDestruct.bind(this), 5000);
    }
  }

  checkDestruct() {
    if ((new Date() - this.lastActivity) / 1000 > selfDestructDuration) {
      console.log(colors.cyan(`Self destructing after ${selfDestructDuration} seconds of inactivity`), this.streamIdentifier, this.streamUrl);
      this.kill(true);
    }
  }

  static generateM3U8(mediaDuration, filename) {
    let index = 0;
    let length;
    let duration = mediaDuration;
    let content = '#EXTM3U\r\n';
    content += '#EXT-X-VERSION:3\r\n';
    content += '#EXT-X-MEDIA-SEQUENCE:0\r\n';
    content += `#EXT-X-TARGETDURATION: ${hlsSegmentDuration}\r\n`;
    content += '#EXT-X-PLAYLIST-TYPE:VOD\r\n';

    while (duration > 0) {
      length = duration >= hlsSegmentDuration ? hlsSegmentDuration : duration;
      content += `#EXTINF: ${length.toFixed(4)}, nodesc\r\n`;
      content += `/segment.ts?file=${filename}${index}.ts\r\n`;
      duration -= length;
      index += 1;
    }

    content += '#EXT-X-ENDLIST';
    fs.writeFileSync(path.join(transcodePath, `${filename}_master.m3u8`), content);
    return content;
  }
}

class StreamSegmentPoller {
  constructor(streamSegmentFilename, errorCallback, successCallback) {
    this.filename = streamSegmentFilename;
    this.streamIdentifier = this.filename.substring(0, 8);
    this.segmentIndex = parseInt(this.filename.substring(8).split('.')[0], 10);
    this.streamObject = streams[this.streamIdentifier];
    console.log(colors.cyan('StreamSegmentPoller'), this.filename, this.streamIdentifier, this.segmentIndex);
    this.maxTries = hlsSegmentDuration * 2 < 10 ? 10 : hlsSegmentDuration * 2;
    this.currentTry = 0;
    this.transcodeStarting = false;
    this.newTranscoderStarted = false;
    this.errorCallback = errorCallback;
    this.successCallback = successCallback;
    this.updateActivity();
    this.poll();
  }

  retry() {
    this.currentTry += 1;
    setTimeout(this.poll.bind(this), 1000);
  }

  updateActivity() {
    if (this.streamObject) {
      this.streamObject.lastActivity = new Date();
    }
  }

  poll() {
    if (this.currentTry > this.maxTries) {
      console.log(colors.red('Poller max try reached'), this.streamIdentifier, this.segmentIndex);
      return this.errorCallback();
    }
    console.log(colors.cyan('Polling'), this.streamIdentifier, this.segmentIndex);
    if (fs.existsSync(path.join(transcodePath, this.filename))) {
      return this.successCallback(fs.createReadStream(path.join(transcodePath, this.filename)));
    }

    let shouldStartTranscode = false;
    if (this.streamObject === undefined) {
      shouldStartTranscode = true;
    } else if (this.transcodeStarting) {
      shouldStartTranscode = false;
    } else if (this.streamObject.process === null) {
      shouldStartTranscode = true;
    } else if (!this.newTranscoderStarted) {
      // Transcoder is active and running. Restart or create new
      // transcoder if user seeked or rewinded by checking the gap.
      let currentTranscodingIndex = null;
      let gapCheckMethod = 'M3U8';
      // Get last transcoded segment from ffmpeg's generat(ed)(ing) m3u8 file
      try {
        const ffmpegM3u8Lines = fs.readFileSync(path.join(transcodePath, `${this.streamIdentifier}.m3u8`), 'utf-8').split('\n').filter(Boolean);
        let count = 0;
        let offset = 0;
        for (let i = ffmpegM3u8Lines.length - 1; i >= 0; i -= 1) {
          if (ffmpegM3u8Lines[i].match('^#EXTINF:[0-9]+')) count += 1;
          if (ffmpegM3u8Lines[i].match('^#EXT-X-MEDIA-SEQUENCE')) offset = parseInt(ffmpegM3u8Lines[i].split(':')[1], 10);
        }
        currentTranscodingIndex = count + offset;
        // eslint-disable-next-line no-empty
      } catch (err) {
        // console.log(err);
      }

      // Fallback to get last transcoded segment number from file system
      if (currentTranscodingIndex === null) {
        gapCheckMethod = 'FILE';
        const streamFiles = glob.sync(path.join(transcodePath, `${this.streamIdentifier}*.ts`), {});
        const lastItem = streamFiles.slice(-1)[0];
        if (lastItem) {
          currentTranscodingIndex = parseInt(path.basename(lastItem).substring(8).split('.')[0], 10);
        }
      }

      currentTranscodingIndex = currentTranscodingIndex === null ? 0 : currentTranscodingIndex;

      if (this.segmentIndex - currentTranscodingIndex >= hlsSegmentMaxGap) {
        console.log(colors.cyan('Start new transcoder because gap is too big (user seeked or rewinded)'), `Gap checking method: ${gapCheckMethod}`);
        shouldStartTranscode = true;
      }
    }

    if (shouldStartTranscode && !this.newTranscoderStarted) {
      let newStreamObject = this.streamObject;
      this.transcodeStarting = true;
      this.newTranscoderStarted = true;
      if (this.streamObject && this.streamObject.process !== null) {
        this.streamObject.process.kill();
        clearInterval(this.streamObject.selfDestructTimer);
        this.streamObject.selfDestructTimer = null;
        this.streamObject.seekToSegment = this.segmentIndex;
      }
      if (this.streamObject === undefined) {
        newStreamObject = new Stream(
          this.streamObject.streamUrl,
          this.streamObject.streamIdentifier,
          this.segmentIndex,
          this.streamObject.finishCallback,
        );
      }
      newStreamObject.spawn(() => {
        this.transcodeStarting = false;
        this.retry();
      }, () => this.errorCallback());
    } else {
      this.retry();
    }

    return undefined;
  }
}

http.createServer((req, res) => {
  const uri = url.parse(req.url).pathname;
  const { query } = url.parse(req.url, true);

  if (uri === '/watch.m3u8') {
    if (query.url) {
      const streamUrl = query.url;
      if (Object.keys(streams).length < maxProcess) {
        const streamIdentifier = uniqueFilename('');
        const streamObject = new Stream(streamUrl, streamIdentifier, 0, () => {
          delete streams[streamIdentifier];
        });
        streams[streamIdentifier] = streamObject;
        streamObject.spawn((m3u8) => {
          res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
          res.end(m3u8);
        }, () => {
          streamObject.kill();
          delete streams[streamIdentifier];
          console.log(colors.red('Spawn failed. Returning 500.'), streamIdentifier);
          res.writeHead(500);
          res.end();
        });
      } else {
        console.log(colors.red('Max allowed stream exceeded. Returning 500.'));
        res.writeHead(500);
        res.end();
      }
    } else {
      console.log(colors.red('No URL param found in URL. Returning 500.'));
      res.writeHead(500);
      res.end();
    }
  } else if (uri === '/segment.ts') {
    const segmentName = query.file;
    // eslint-disable-next-line no-new
    new StreamSegmentPoller(segmentName, () => {
      console.log(colors.red('Poller failed. Returning 500.'), segmentName);
      res.writeHead(500);
      res.end();
    }, (fileStream) => {
      console.log(colors.green('Returning file'), segmentName);
      fileStream.pipe(res).on('close', () => {
        fileStream.destroy();
      });
    });
  }
}).listen(serverPort, () => {
  console.log(colors.green('Server listening on port %d'), serverPort);
});
