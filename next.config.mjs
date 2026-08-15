/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['ws', 'https-proxy-agent'],
};
export default nextConfig;
