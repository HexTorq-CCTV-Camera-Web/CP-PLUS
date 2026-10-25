// Compatibility entry point: node server.js. No parent-folder dependencies.
import('./server.mjs').then(({ createApp }) => {
  const port = Number(process.env.PORT || 8000);
  const server = createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Choose another PORT.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`CPPlus v1: http://localhost:${port}`));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
