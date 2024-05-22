const http = require("http");
const url = require("url");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
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

async function uploadToS3(s3Key, filePath) {
  try {
    const params = {
      Bucket: "sportscamera040621",
      Key: s3Key,
      Body: fs.createReadStream(filePath),
    };
    const uploadResult = await S3.send(new PutObjectCommand(params));
    // Elimina el archivo local después de subirlo a S3
    fs.unlinkSync(filePath);

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

  if (pathname === "/start-record") {
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

    // Formatear la hora en el formato HH-MM sin segundos
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
      ffmpegProcesses[rtsp].kill("SIGTERM");
      delete ffmpegProcesses[rtsp];
    }

    fs.mkdir(folderPath, (error) => {
      if (error) {
        console.error("Error al crear la carpeta:", error);
        response.writeHead(500);
        response.end("Error al crear la carpeta");
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
      ]);

      ffmpegProcesses[rtsp] = { process: ffmpeg, folderName };

      ffmpeg.stdout.on("data", (data) => {
        console.log(`stdout:\n${data}`);
      });
      ffmpeg.stderr.on("data", (data) => {
        console.log(`stdout: ${data}`);
      });

      response.writeHead(200);
      response.end("Transmisión HLS iniciada");
    });
  }

  if (pathname === "/stop-record") {
    const { rtsp } = query;
    if (
      rtsp in ffmpegProcesses &&
      ffmpegProcesses[rtsp].process &&
      ffmpegProcesses[rtsp].process.exitCode === null
    ) {
      const endTime = new Date();
      ffmpegProcesses[rtsp].process.kill("SIGTERM");

      ffmpegProcesses[rtsp].process.on("close", async () => {
        const { folderName } = ffmpegProcesses[rtsp];

        fs.appendFileSync(
          `${folderName}/${folderName}a.m3u8`,
          "#EXT-X-ENDLIST\n"
        );

        const files = fs.readdirSync(folderName);

        for (const file of files) {
          const filePath = path.join(folderName, file);
          const s3Key = path.basename(filePath);
          await uploadToS3(s3Key, filePath);
        }

        fs.rmdirSync(folderName, { recursive: true });

        const data = folderName.split("a");
        const camera_id = data[0];
        const date = data[1];
        const start_time = data[2].replace(/-/g, ":");
        const end_time = endTime
          .toLocaleTimeString("en-US", { hour12: false })
          .slice(0, -3);
        const video_url = `${folderName}a.m3u8`;

        delete ffmpegProcesses[rtsp];

        try {
          await pool.query(
            "INSERT INTO videos(date, start_time, end_time, video_url, camera_id) VALUES ($1, $2, $3, $4, $5);",
            [date, start_time, end_time, video_url, camera_id]
          );
        } catch (error) {
          console.log(error);
        }
      });
    }
  }

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

  const pathPartsRecord = pathname.split("/").slice(1);
  if (pathPartsRecord[0] === "get-record" && pathPartsRecord.length === 2) {
    const file = pathPartsRecord[1];

    const params = {
      Bucket: "sportscamera040621",
      Key: file,
    };

    try {
      const signedUrl = await getSignedUrl(S3, new GetObjectCommand(params), {
        expiresIn: 3600,
      });
      response.writeHead(302, { Location: signedUrl });
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end("Error retrieving video");
    }
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
