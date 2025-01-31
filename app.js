const express = require("express");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const http = require("http");
const net = require("net");
const url = require("url");

// ----------------------------------------------------
// SERVER A: Express-based endpoint for /proxy?url=...
// ----------------------------------------------------

const app = express();
const EXPRESS_PORT = 3000;

/**
 * e.g.: http://localhost:3000/proxy?url=https://example.com
 */
app.get("/proxy", async (req, res) => {
  try {
    let targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).send("Missing 'url' query parameter.");
    }

    targetUrl = url.parse(req.url).query;
    targetUrl = targetUrl.substr(4 + targetUrl.indexOf('url='));

    // Fetch the page
    const response = await fetch(targetUrl);
    const html = await response.text();

    // Run Readability
    const dom = new JSDOM(html, { url: targetUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    // If parsing fails, return original HTML
    if (!article) {
      return res.send(html);
    }

    const fixedLinks = (content) => {
        const dom = new JSDOM(content);
        const document = dom.window.document;
        const anchors = document.querySelectorAll("a[href]");
        anchors.forEach(a => {
            const originalUrl = a.getAttribute("href");
            // unescaped since we use the raw querystring
            a.setAttribute("href", "/proxy?url=" + originalUrl);
        });
        return dom.serialize();
    }

    // Return simplified HTML
    res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${article.title}</title>
        </head>
        <body>
            <h1>${article.siteName || ''}</h1>
            <h2>${article.title} (<a href="${targetUrl}">view original</a>)</h2>
            <p><i>${article.byline || ''}</i>${article.byline && article.publishedTime ? ' - ' : ''} ${article.publishedTime || ''}</p>
            ${article.excerpt ? '<p>'+article.excerpt+'</p>' : ''}
            <hr />
            
          ${fixedLinks(article.content)}
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.listen(EXPRESS_PORT, () => {
  console.log(`Express server for direct requests running on http://localhost:${EXPRESS_PORT}`);
});

// ----------------------------------------------------
// Raw HTTP proxy on port 8080
// ----------------------------------------------------

const PROXY_PORT = 8080;

const proxyServer = http.createServer(async (req, res) => {
  try {
    // 1. Parse the URL from the request (which is in absolute form when using a forward proxy).
    const parsedUrl = url.parse(req.url);
    const hostname = parsedUrl.hostname;
    const protocol = parsedUrl.protocol;

    if (!hostname || !protocol) {
      // The browser might send some requests that don't have absolute URLs
      // (e.g. checking proxy.pac files) or might be an invalid request
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Invalid proxy request or missing protocol/host.");
    }

    // 2. Fetch the original resource
    const targetUrl = parsedUrl.href; // e.g. "http://example.com/foo"
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: { ...req.headers },
    });

    // 3. Check if it's HTML
    const contentType = response.headers.get("content-type") || "";
    const isHTML = contentType.includes("text/html");

    // 4. Read the response body
    let body = await response.text();

    // 5. If it's HTML, apply Mozilla Readability
    if (isHTML) {
      const dom = new JSDOM(body, { url: targetUrl });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      // If parsing succeeded, replace the body
      if (article) {
        body = `
          <html>
            <head>
              <meta charset="utf-8" />
              <title>${article.title}</title>
            </head>
            <body>
              ${article.content}
            </body>
          </html>
        `;
      }
    }

    const headers = Object.fromEntries(response.headers.entries());
    delete headers["content-length"];

    res.writeHead(response.status, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Proxy error: " + err.message);
  }
});

// 7. Handle HTTPS CONNECT requests for tunneling
proxyServer.on("connect", (req, clientSocket, head) => {
  const { port, hostname } = url.parse(`http://${req.url}`);

  // Open a TCP connection to the requested host/port
  const serverSocket = net.connect(port || 443, hostname, () => {
    // Acknowledge CONNECT
    clientSocket.write(
      "HTTP/1.1 200 Connection Established\r\n" +
        "Proxy-agent: Node-Readability-Proxy\r\n" +
        "\r\n"
    );

    // Pipe data both ways
    serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on("error", () => {
    clientSocket.end();
  });
});

// 8. Start the proxy server
proxyServer.listen(PROXY_PORT, () => {
  console.log(`Forward proxy server (with Readability) running on port ${PROXY_PORT}`);
});
