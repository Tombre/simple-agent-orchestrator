import net from "node:net";

export async function getAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => address && typeof address === "object"
        ? resolve(address.port)
        : reject(new Error("Could not allocate a TCP port")));
    });
  });
}

export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port.length > 0
      && url.username.length === 0
      && url.password.length === 0
      && url.pathname === "/"
      && url.search.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}
