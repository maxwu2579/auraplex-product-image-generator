import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/images/remove-background",
        destination: "http://127.0.0.1:8000/api/images/remove-background",
      },
      {
        source: "/api/images/detect-subjects",
        destination: "http://127.0.0.1:8000/api/images/detect-subjects",
      },
      {
        source: "/api/health",
        destination: "http://127.0.0.1:8000/api/health",
      },
      {
        source: "/api/brands/:path*",
        destination: "http://127.0.0.1:8000/api/brands/:path*",
      },
    ];
  },
};

export default nextConfig;
