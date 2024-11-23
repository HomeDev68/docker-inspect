// src/server.js
import express from 'express';
import cors from 'cors';
import Docker from 'dockerode';
import Redis from 'ioredis';
import { promisify } from 'util';
import { Stream } from 'stream';
import tar from 'tar-stream';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');
const jobQueue = new Redis(process.env.REDIS_URL || 'redis://redis:6379', { db: 1 });

app.use(cors());
app.use(express.json());

// Utility functions
const formatSize = (size) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let formattedSize = size;
  let unitIndex = 0;

  while (formattedSize >= 1024 && unitIndex < units.length - 1) {
    formattedSize /= 1024;
    unitIndex++;
  }

  return `${formattedSize.toFixed(1)}${units[unitIndex]}`;
};

const buildFileTree = (files) => {
  const root = {
    name: '',
    path: '/',
    size: 0,
    type: 'directory',
    children: []
  };

  const pathMap = { '/': root };

  // Sort files to ensure parents are processed before children
  const sortedFiles = files.sort((a, b) => 
    (a.path.match(/\//g) || []).length - (b.path.match(/\//g) || []).length
  );

  for (const file of sortedFiles) {
    const parentPath = path.dirname(file.path);
    if (!pathMap[parentPath]) continue;

    const node = {
      name: file.name,
      path: file.path,
      size: formatSize(file.size),
      type: file.type,
      modified: file.modified
    };

    if (file.type === 'directory') {
      node.children = [];
    }

    pathMap[file.path] = node;
    pathMap[parentPath].children.push(node);
  }

  return root.children;
};

const extractTarStream = async (tarStream) => {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const files = [];

    extract.on('entry', (header, stream, next) => {
      const content = [];
      stream.on('data', chunk => content.push(chunk));
      stream.on('end', () => {
        files.push({
          name: path.basename(header.name),
          path: header.name,
          size: header.size,
          type: header.type === 'directory' ? 'directory' : 'file',
          modified: new Date(header.mtime).toISOString(),
          content: Buffer.concat(content).toString('utf8')
        });
        next();
      });
      stream.resume();
    });

    extract.on('finish', () => resolve(files));
    extract.on('error', reject);

    tarStream.pipe(extract);
  });
};

// Worker class for processing Docker inspection jobs
class Worker {
  async processJob(jobData) {
    const { imageUrl, jobId } = jobData;

    try {
      // Pull image if not exists
      await docker.pull(imageUrl);

      // Get image details
      const image = await docker.getImage(imageUrl);
      const inspect = await image.inspect();

      // Create temporary container
      const container = await docker.createContainer({
        Image: imageUrl,
        Cmd: ['true'],
        Tty: true
      });

      // Get file listing
      const filesResult = await this.listFiles(container, '/app');

      // Clean up container
      await container.remove();

      const result = {
        inspection: {
          manifest: inspect,
          layers: inspect.RootFS.Layers.map(layer => ({
            digest: layer,
            size: formatSize(inspect.Size / inspect.RootFS.Layers.length) // Approximate size
          })),
          config: {
            created: inspect.Created,
            architecture: inspect.Architecture,
            os: inspect.Os,
            env: inspect.Config.Env
          }
        },
        files: filesResult
      };

      // Store results in Redis
      await redis.setex(
        `result:${jobId}`,
        3600, // Cache for 1 hour
        JSON.stringify(result)
      );

      // Update job status
      await jobQueue.hset(`job:${jobId}`, {
        status: 'completed',
        result: JSON.stringify(result)
      });

    } catch (error) {
      await jobQueue.hset(`job:${jobId}`, {
        status: 'failed',
        error: error.message
      });
    }
  }

  async listFiles(container, path) {
    const tarStream = await container.getArchive({ path });
    const files = await extractTarStream(tarStream);
    return buildFileTree(files);
  }

  async getFileContents(container, filePath) {
    const tarStream = await container.getArchive({ path: filePath });
    const files = await extractTarStream(tarStream);
    return files[0];
  }
}

// API Routes
app.post('/api/inspect', async (req, res) => {
  try {
    const { image_name: imageUrl } = req.body;
    const jobId = uuidv4();

    // Create job in queue
    await jobQueue.hmset(`job:${jobId}`, {
      imageUrl,
      jobId,
      status: 'pending'
    });

    // Process job in background
    const worker = new Worker();
    worker.processJob({ imageUrl, jobId }).catch(console.error);

    res.json({ job_id: jobId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  try {
    const jobData = await jobQueue.hgetall(`job:${req.params.jobId}`);

    if (!jobData) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const response = {
      status: jobData.status,
      result: jobData.result ? JSON.parse(jobData.result) : null,
      error: jobData.error || null
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/results/:jobId', async (req, res) => {
  try {
    // Check cache first
    const cachedResult = await redis.get(`result:${req.params.jobId}`);
    
    if (cachedResult) {
      return res.json(JSON.parse(cachedResult));
    }

    // If not in cache, check job status
    const jobData = await jobQueue.hgetall(`job:${req.params.jobId}`);

    if (!jobData || jobData.status !== 'completed') {
      return res.status(404).json({ error: 'Results not found' });
    }

    res.json(JSON.parse(jobData.result));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/file/:imageName', async (req, res) => {
  try {
    const { imageName } = req.params;
    const { path: filePath } = req.query;

    // Create temporary container
    const container = await docker.createContainer({
      Image: imageName,
      Cmd: ['true'],
      Tty: true
    });

    try {
      const worker = new Worker();
      const fileData = await worker.getFileContents(container, filePath);
      res.json(fileData);
    } finally {
      // Clean up container
      await container.remove();
    }
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
