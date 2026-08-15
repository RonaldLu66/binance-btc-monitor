/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['ws', 'https-proxy-agent'],
  },
};
export default nextConfig;
