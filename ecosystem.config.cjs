module.exports = {
  apps: [
    {
      name: "market-discovery",
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
      name: "digest",
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
  ],
};
