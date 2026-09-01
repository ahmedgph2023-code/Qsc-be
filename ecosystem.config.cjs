/** PM2 process file for Windows/Linux deploy hosts. */
module.exports = {
  apps: [
    {
      name: "qsc-backend",
      script: "dist/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
