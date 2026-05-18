// All process names are prefixed with `pmw-` to avoid collisions with other
// projects on the same server (e.g. dork-track has its own `tg-control`).
module.exports = {
  apps: [
    {
      name: "pmw-market-discovery",
      script: "npx",
      args: "tsx src/market-discovery.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      kill_timeout: 10000,
      out_file: "state/market-discovery.out.log",
      error_file: "state/market-discovery.err.log",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "pmw-digest",
      script: "npx",
      args: "tsx src/digest.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      kill_timeout: 10000,
      out_file: "state/digest.out.log",
      error_file: "state/digest.err.log",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "pmw-tg-control",
      script: "npx",
      args: "tsx src/tg-control.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      kill_timeout: 10000,
      out_file: "state/tg-control.out.log",
      error_file: "state/tg-control.err.log",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
