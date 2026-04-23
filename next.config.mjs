/** @type {import('next').NextConfig} */
const nextConfig = {
  // Mark pg as external so Next.js doesn't try to bundle native bindings.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
