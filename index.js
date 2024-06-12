const http = require("http");
const url = require("url");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { uploadFile } = require("./controller");

let ffmpegProcesses = {};
let ffmpegProcessesStream = {};

const requestHandler = async (request, response) => {
  const parsedUrl = url.parse(request.url, true);
  const { pathname, query } = parsedUrl;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (pathname === "/start-record") {
    console.log('START RECORD EXECUTE')
    const { camera_id, rtsp } = query;
    const now = new Date();
    const options = {
      timeZone: "America/Argentina/Buenos_Aires",
      hour12: false,
    };
    const formattedDate = new Intl.DateTimeFormat("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      ...options,
    })
      .format(now)
      .split("/")
      .reverse()
      .join("-");

    const formattedTime = new Intl.DateTimeFormat("es-AR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      ...options,
    })
      .format(now)
      .replace(/:/g, "-")
      .slice(0, -3);
    const folderName = `${camera_id}a${formattedDate}a${formattedTime}`;
    const folderPath = path.join(__dirname, folderName);

    if (
      rtsp in ffmpegProcesses &&
      ffmpegProcesses[rtsp] &&
      ffmpegProcesses[rtsp].exitCode === null
    ) {
      await fetch(`http://localhost:3000/stop-record?rtsp=${rtsp}`)
    }
    
    if(!fs.existsSync(folderPath)){
      fs.mkdir(folderPath, (error) => {
        if (error) {
          console.error("Error al crear la carpeta:", error);
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Error al crear la carpeta" }));
          return;
        }
        const filename = path.join(folderPath, `${folderName}a.m3u8`);
        const ffmpeg = spawn("ffmpeg", [
          "-i",
          rtsp,
          "-r",
          "25",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "30",
          "-an",
          "-force_key_frames",
          "expr:gte(t,n_forced*20)",
          "-f",
          "hls",
          "-hls_time",
          "20",
          "-hls_list_size",
          "0",
          "-y",
          filename,
        ], { windowsHide: true });
  
        ffmpegProcesses[rtsp] = { process: ffmpeg, folderName, start_time: Date.now()};
  
        ffmpeg.stdout.on("data", (data) => {
          console.log(`stdout:\n${data}`);
        });
        ffmpeg.stderr.on("data", (data) => {
          console.log(`stdout: ${data}`);
        });
  
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "Transmisión HLS iniciada" }));
      });
    }
    
  }

  if (pathname === "/stop-record") {
    console.log('STOP RECORD EXECUTE')
    const { rtsp } = query;

    if (
      rtsp in ffmpegProcesses &&
      ffmpegProcesses[rtsp].process &&
      ffmpegProcesses[rtsp].process.exitCode === null
    ) {
      const endTime = new Date();
      ffmpegProcesses[rtsp].process.kill("SIGKILL");

      ffmpegProcesses[rtsp].process.on("exit", async () => {
        const { folderName } = ffmpegProcesses[rtsp];
        const folderPath = path.join(__dirname, folderName);

        fs.appendFileSync(
          `${path.join(folderPath, folderName)}a.m3u8`,
          "#EXT-X-ENDLIST\n"
        );

        const files = fs.readdirSync(folderPath);

        const promises = files.map(async (file) => {
          const filePath = path.join(folderPath, file);
          const s3Key = path.basename(filePath);
          await uploadFile(filePath, s3Key);
        })

        await Promise.all(promises);

        fs.rmSync(folderPath, { recursive: true, force: true });

        const data = folderName.split("a");
        const camera_id = data[0];
        const date = data[1];
        const start_time = data[2].replace(/-/g, ":");
        const end_time = endTime.toTimeString().slice(0, 5);
        const video_url = `${folderName}a.m3u8`;

        delete ffmpegProcesses[rtsp];

        try {
          const res = await fetch("https://sportscamera.vercel.app/api/videos/uploadToDb", {
            method: "POST",
            headers:{
              "Origin": "http://localhost:3000",
            },
            body: JSON.stringify({
              date,
              start_time,
              end_time,
              video_url,
              camera_id,
            }),
          });

          if(res.ok){
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ start_time, end_time }));
          }else{
            response.writeHead(404, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: 'No se pudo subir el video a la db'}));
          }
        
        } catch (error) {
          response.writeHead(404, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error }));
          console.log(error);
        }
      });
    }
  }

  if (pathname === "/exist-record") {
    const { rtsp } = query;
    if (rtsp in ffmpegProcesses) {
      const responseBody = {
        exists: true,
        start_time: ffmpegProcesses[rtsp].start_time
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(responseBody));
      return;
    } else {
      const responseBody = {
          exists: false
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    }
  }

  if (pathname === "/get-thumbnail") {
    const { rtsp } = query;

    const ip = rtsp.match(/rtsp:\/\/admin:password123@([\d.]+):/)[1];
    const folderPath = path.join(__dirname, ip);
    

    fs.mkdir(folderPath, (error) => {
      const filePath = path.join(folderPath, 'thumbnail.jpg');

      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-i",
        rtsp,
        "-vframes",
        "1",
        filePath,
      ], { windowsHide: true });

      ffmpeg.stdout.on("data", (data) => {
        console.log(`stdout:\n${data}`);
      });
      ffmpeg.stderr.on("data", (data) => {
        console.log(`stdout: ${data}`);
      });

      ffmpeg.on('close', ()=>{
        ffmpeg.kill("SIGKILL");
        response.writeHead(200, { "Content-Type": 'image/jpg' })
        fs.createReadStream(filePath).pipe(response)
      })
    })
  }

  if (pathname === "/run-stream") {
    const { rtsp } = query;

    if (!rtsp) {
      response.writeHead(404);
      response.end("no parameter");
    } else {
      const ip = rtsp.match(/rtsp:\/\/admin:password123@([\d.]+):/)[1];
      const folderPath = path.join(__dirname, ip);

      if (
        rtsp in ffmpegProcessesStream &&
        ffmpegProcessesStream[rtsp] &&
        ffmpegProcessesStream[rtsp].exitCode === null
      ) {
        ffmpegProcessesStream[rtsp].kill();
        delete ffmpegProcessesStream[rtsp];
      }

      if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true });
      }

      fs.mkdir(folderPath, (error) => {
        const filename = path.join(folderPath, "index.m3u8");

        const ffmpeg = spawn("ffmpeg", [
          "-i",
          rtsp,
          "-c:v",
          "copy",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-f",
          "hls",
          "-hls_time",
          "2",
          "-hls_list_size",
          "2",
          "-start_number",
          "1",
          "-hls_flags",
          "delete_segments",
          "-y",
          filename,
        ]);

        ffmpegProcessesStream[rtsp] = ffmpeg;

        response.writeHead(200);
        response.end("Transmisión HLS iniciada");
      });
    }
  }

  const pathParts = pathname.split("/").slice(1);
  if (pathParts[0] === "get-stream" && pathParts.length === 3) {
    const ip = pathParts[1];
    const file = pathParts[2];
    const folderPath = path.join(__dirname, ip, "/", file);
    const filePath = "./" + ip + "/" + file;

    fs.readFile(filePath, function (error, content) {
      if (error) {
        response.writeHead(500);
        response.end(
          "Sorry, check with the site admin for error:" + error.code + " ..\n"
        );
        response.end();
      } else {
        response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        response.end(content, "utf-8");
      }
    });
  }

  if (pathname === "/") {
    const indexPath = path.join(__dirname, "index.html");
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("Error interno del servidor");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(data);
    });
    return;
  }
};

const server = http.createServer(requestHandler);

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
