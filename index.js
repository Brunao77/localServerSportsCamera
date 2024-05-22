const http = require("http");
const url = require("url");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
require("dotenv").config();
const pg = require("pg");

const pool = new pg.Pool({
  connectionString: process.env.PGCONNECTIONSTRING,
});

let ffmpegProcesses = {};
let ffmpegProcessesStream = {};

const S3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.ACCOUNTID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.ACCESSKEYID,
    secretAccessKey: process.env.SECRETACCESSKEY,
  },
});

async function uploadToS3(filename) {
  try {
    const params = {
      Bucket: "sportscamera040621",
      Key: filename,
      Body: fs.createReadStream(filename),
    };
    const uploadResult = await S3.send(new PutObjectCommand(params));
    // Elimina el archivo local después de subirlo a S3
    fs.unlinkSync(filename);

    return uploadResult;
  } catch (error) {
    console.error("Error al subir el archivo a S3:", error);
  }
}

const requestHandler = async (request, response) => {
  const parsedUrl = url.parse(request.url, true);
  const { pathname, query } = parsedUrl;
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:4321");
  response.setHeader("Access-Control-Allow-Methods", "GET");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (pathname === "/exist-record") {
    const { rtsp } = query;
    if (rtsp in ffmpegProcesses) {
      response.writeHead(200);
      response.end("true");
      return;
    } else {
      response.writeHead(200);
      response.end("false");
    }
  }

  if (pathname === "/run-stream") {
    const { rtsp } = query;
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
      if (error) {
        console.error("Error al crear la carpeta:", error);
        response.writeHead(500);
        response.end("Error al crear la carpeta");
        return;
      }
      const filename = path.join(folderPath, "index.m3u8");

      const ffmpeg = spawn("ffmpeg", [
        "-i",
        rtsp,
        "-c:v",
        "copy",
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

  const pathParts = pathname.split("/").slice(1);
  if (pathParts[0] === "get-stream" && pathParts.length === 3) {
    const ip = pathParts[1];
    const file = pathParts[2];
    const folderPath = path.join(__dirname, ip, "/", file);
    var filePath = "./" + ip + "/" + file;

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

  if (pathname === "/start-record") {
    const { camera_id, rtsp } = query;

    if (
      !(rtsp in ffmpegProcesses) ||
      (ffmpegProcesses[rtsp].process &&
        ffmpegProcesses[rtsp].process.exitCode !== null)
    ) {
      const now = new Date();
      const formattedDate = now.toISOString().split("T")[0];
      const formattedTime = now
        .toLocaleTimeString("en-US", { hour12: false })
        .replace(/:/g, "-")
        .slice(0, -3);
      const filename = `${camera_id}a${formattedDate}a${formattedTime}`;

      const ffmpeg = spawn("ffmpeg", [
        "-i",
        rtsp,
        "-c:v",
        "copy",
        "-an",
        "-f",
        "flv",
        `${filename}.flv`,
      ]);

      ffmpegProcesses[rtsp] = {
        process: ffmpeg,
        filename,
      };

      ffmpeg.stdout.on("data", (data) => {
        console.log(`stdout:\n${data}`);
      });
      ffmpeg.stderr.on("data", (data) => {
        console.log(`stdout: ${data}`);
      });

      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ message: "Recording started", filename }));
    } else {
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error: "Recording already in progress or RTSP stream not found",
        })
      );
    }
  }

  if (pathname === "/stop-record") {
    const { rtsp } = query;
    if (
      rtsp in ffmpegProcesses &&
      ffmpegProcesses[rtsp].process &&
      ffmpegProcesses[rtsp].process.exitCode === null
    ) {
      ffmpegProcesses[rtsp].process.kill("SIGKILL");

      ffmpegProcesses[rtsp].process.on("exit", async () => {
        const filename = ffmpegProcesses[rtsp].filename;
        const endTime = new Date();
        delete ffmpegProcesses[rtsp];

        const ffmpeg = spawn("ffmpeg", [
          "-i",
          `${filename}.flv`,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "30",
          "-an",
          `${filename}.mp4`,
        ]);

        ffmpeg.stdout.on("data", (data) => {
          console.log(`stdout:\n${data}`);
        });
        ffmpeg.stderr.on("data", (data) => {
          console.log(`stdout: ${data}`);
        });

        ffmpeg.on("exit", async () => {
          setTimeout(async () => {
            await uploadToS3(`${filename}.mp4`);
            fs.unlinkSync(`${filename}.flv`);

            const data = filename.split("a");

            const camera_id = data[0];
            const date = data[1];
            const start_time = data[2].replace(/-/g, ":");
            const end_time = endTime
              .toLocaleTimeString("en-US", { hour12: false })
              .slice(0, -3);
            const video_url = `https://pub-68389555a737432790f03f489addece1.r2.dev/${filename}.mp4`;

            try {
              await pool.query(
                "INSERT INTO videos(date, start_time, end_time, video_url, camera_id) VALUES ($1, $2, $3, $4, $5);",
                [date, start_time, end_time, video_url, camera_id]
              );
            } catch (error) {
              console.log(error);
            }

            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ message: "Recording stopped" }));
          }, 5000);
        });
      });
      ffmpegProcesses[rtsp].process.on("error", (error) => {
        console.error(error);
      });
    } else {
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          error: "No active recording found for the specified RTSP stream",
        })
      );
    }
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
