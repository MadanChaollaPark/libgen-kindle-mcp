import { DOMParser, parseHTML } from "linkedom";

const catalog = "https://libgen.xyz";
const resolverHosts = new Set(["libgen.xyz", "libgen.fyi", "libgen.stream", "freescienceengineering.org"]);
const fileHosts = new Set([
  ...resolverHosts, "libgen.download", "libgen.vg", "libgen.li", "libgen.la", "libgen.gl", "libgen.bz",
  "booksdl.lc", "library.lol",
]);
const redirects = new Set([301, 302, 303, 307, 308]);
const gutenbergMirror = "https://gutenberg.pglaf.org";
const gutenbergHosts = new Set(["gutenberg.pglaf.org"]);

export const formats = ["epub", "pdf"];
export const maxDownloadBytes = 50_000_000;

function requestTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safeUrl(address, hosts, base) {
  const url = new URL(address, base);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !hosts.has(url.hostname)) {
    throw new Error("Download host is outside the configured LibGen mirrors.");
  }
  return url;
}

async function request(url, signal, method = "GET") {
  const response = await fetch(url, { signal, method, redirect: "manual" });
  if (!response.ok && !redirects.has(response.status)) {
    await response.body?.cancel();
    throw new Error(`${url.hostname} returned HTTP ${response.status}.`);
  }
  return response;
}

async function readBounded(response, maxBytes) {
  if (!response.body) throw new Error("The source returned an empty response.");
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body.cancel();
    throw new Error("The source file exceeds the size limit.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("The source file exceeds the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size);
}

async function getJson(url, signal, method) {
  const response = await request(url, signal, method);
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new Error(`${url.hostname} did not return JSON for this request.`);
  }
  return JSON.parse((await readBounded(response, 5_000_000)).toString("utf8"));
}

async function catalogRequest(path, params, signal) {
  const url = new URL(path, catalog);
  url.search = new URLSearchParams(params).toString();
  const data = await getJson(url, signal);
  if (data.isError || !data.result) throw new Error("The LibGen catalog could not fulfill the request.");
  return data.result;
}

function bookMetadata(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id);
  const format = String(raw.fileExtension).toLowerCase();
  if (!/^\d{1,12}$/.test(id) || !formats.includes(format)) return null;
  return {
    book_id: id,
    title: typeof raw.title === "string" ? raw.title.trim().slice(0, 300) : "Untitled",
    authors: Array.isArray(raw.author)
      ? raw.author.filter((author) => typeof author === "string").slice(0, 8)
          .map((author) => author.trim().slice(0, 160))
      : [],
    format,
    language: typeof raw.language === "string" ? raw.language.slice(0, 30) : null,
    year: Number.isInteger(raw.year) ? raw.year : null,
    bytes: Number.isSafeInteger(raw.fileSize) && raw.fileSize > 0 ? raw.fileSize : null,
  };
}

export async function searchBooks({ query, collection, format, limit }, signal) {
  const collections = collection === "all" ? ["fiction", "libgen"] : [collection];
  const responses = await Promise.allSettled(collections.map((name) =>
    catalogRequest("/api/search/by-params", { query, collection: name, from: "0" }, requestTimeout(signal, 12_000)),
  ));
  const unavailable = [];
  const books = new Map();
  for (const [index, response] of responses.entries()) {
    if (response.status === "rejected" || !Array.isArray(response.value.books)) {
      unavailable.push(collections[index]);
      continue;
    }
    for (const raw of response.value.books) {
      const book = bookMetadata(raw);
      if (book && (!format || book.format === format)) books.set(book.book_id, book);
    }
  }
  if (unavailable.length === collections.length) throw new Error("LibGen search is temporarily unavailable.");
  const normalizedQuery = query.toLowerCase();
  const score = (book) => Number(book.title.toLowerCase() === normalizedQuery) * 2 +
    Number(book.format === "epub");
  return {
    books: [...books.values()].sort((a, b) => score(b) - score(a)).slice(0, limit),
    ...(unavailable.length ? { unavailable_collections: unavailable } : {}),
  };
}

export function validateBookFile(content, format) {
  if (format === "pdf" && content.subarray(0, 5).toString() === "%PDF-") return;

  // EPUB's first ZIP entry stores the uncompressed mimetype.
  if (format === "epub" && content.length >= 58 && content.readUInt32LE(0) === 0x04034b50 &&
      content.readUInt16LE(8) === 0 && content.readUInt16LE(26) === 8 &&
      content.subarray(30, 38).toString() === "mimetype") {
    const mimeStart = 38 + content.readUInt16LE(28);
    if (content.subarray(mimeStart, mimeStart + 20).toString() === "application/epub+zip") return;
  }
  throw new Error(`The mirror returned a response that does not look like a valid ${format.toUpperCase()}.`);
}

async function fetchBookFile(address, base, book, maxBytes, signal, hosts = fileHosts) {
  let url = safeUrl(address, hosts, base);
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await request(url, signal);
    if (redirects.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("The mirror returned a redirect without a location.");
      url = safeUrl(location, hosts, url);
      continue;
    }

    if (response.headers.get("content-type")?.includes("text/html")) {
      const text = (await readBounded(response, 500_000)).toString("utf8");
      const { document } = parseHTML(text);
      const link = document.querySelector("#main > tr:first-child > td:nth-child(2) > a[href]");
      if (!link) throw new Error(`${url.hostname} returned a web page without a file link.`);
      url = safeUrl(link.getAttribute("href"), hosts, url);
      continue;
    }

    const content = await readBounded(response, maxBytes);
    validateBookFile(content, book.format);
    return content;
  }
  throw new Error("The mirror exceeded the redirect limit.");
}

async function gutendexMetadata(id, signal) {
  const raw = await getJson(new URL(`https://gutendex.com/books/${id}/`), signal);
  if (String(raw.id) !== id || raw.copyright !== false || !raw.formats?.["application/epub+zip"]) {
    throw new Error("Gutendex has no matching public-domain EPUB.");
  }
  return {
    title: raw.title,
    author: raw.authors?.map((author) => author.name),
    language: raw.languages?.[0],
  };
}

async function gutenbergCatalogMetadata(id, signal) {
  const response = await request(new URL(`/cache/epub/${id}/pg${id}.rdf`, gutenbergMirror), signal);
  const xml = (await readBounded(response, 500_000)).toString("utf8");
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const field = (name) => document.getElementsByTagName(name)[0]?.textContent.trim();
  if (field("dcterms:rights") !== "Public domain in the USA." || !field("dcterms:title")) {
    throw new Error("Project Gutenberg has no matching public-domain edition.");
  }
  return {
    title: field("dcterms:title"),
    author: Array.from(document.getElementsByTagName("dcterms:creator"), (creator) =>
      creator.getElementsByTagName("pgterms:name")[0]?.textContent.trim(),
    ),
    language: field("dcterms:language"),
  };
}

async function fetchGutenbergBook(bookId, maxBytes, signal) {
  const id = bookId.slice("gutenberg:".length);
  const metadataComplete = new AbortController();
  const lookupSignal = requestTimeout(AbortSignal.any([signal, metadataComplete.signal]), 10_000);
  let metadata;
  try {
    metadata = await Promise.any([gutenbergCatalogMetadata(id, lookupSignal), gutendexMetadata(id, lookupSignal)]);
  } catch {
    throw new Error("Could not look up a Project Gutenberg edition marked public domain in the US.");
  } finally {
    metadataComplete.abort();
  }
  const book = { ...bookMetadata({ ...metadata, id, fileExtension: "epub" }), book_id: bookId };
  for (const suffix of [".epub", "-images-3.epub"]) {
    try {
      const content = await fetchBookFile(
        `/cache/epub/${id}/pg${id}${suffix}`, gutenbergMirror, book, maxBytes, signal, gutenbergHosts,
      );
      return { book, content };
    } catch (error) {
      signal.throwIfAborted();
      if (suffix === "-images-3.epub") throw error;
    }
  }
}

export async function fetchBook(bookId, maxBytes = maxDownloadBytes, clientSignal) {
  const signal = requestTimeout(clientSignal, 35_000);
  if (bookId.startsWith("gutenberg:")) return fetchGutenbergBook(bookId, maxBytes, signal);

  const raw = await catalogRequest("/api/search/by-id", { id: bookId }, requestTimeout(signal, 10_000));
  const book = bookMetadata(raw);
  if (!book || book.book_id !== bookId) throw new Error("Choose an EPUB or PDF ID from search_books.");
  if (book.bytes > maxBytes) throw new Error("The catalog lists this book above the configured file limit.");

  const result = await catalogRequest(
    "/api/download/links-by-id", { id: bookId }, requestTimeout(signal, 10_000),
  );
  const links = Array.isArray(result.links) ? result.links : [];
  const candidates = links.flatMap((address) => {
    try {
      const landing = safeUrl(address, resolverHosts);
      return landing.searchParams.has("l") ? [landing] : [];
    } catch {
      return [];
    }
  });

  // The two HTTPS mirrors are tried before the backup returned by the catalog.
  candidates.sort((a, b) => Number(a.hostname === "freescienceengineering.org") -
    Number(b.hostname === "freescienceengineering.org"));
  const failures = [];
  for (const landing of candidates.slice(0, 3)) {
    try {
      const attemptSignal = requestTimeout(signal, 10_000);
      const resolver = new URL("/api/decrypt", landing);
      resolver.searchParams.set("l", landing.searchParams.get("l"));
      const { downloadLink } = await getJson(resolver, attemptSignal, "POST");
      if (typeof downloadLink !== "string") throw new Error("The mirror returned no download link.");
      const content = await fetchBookFile(downloadLink, landing, book, maxBytes, attemptSignal);
      return { book, content };
    } catch (error) {
      if (signal.aborted && clientSignal?.aborted) clientSignal.throwIfAborted();
      // Fetch and parse errors can contain a signed URL, so only report known messages.
      const message = error.constructor === Error ? error.message : "Request or response failed.";
      failures.push(`${landing.hostname}: ${message}`);
      if (signal.aborted) break;
    }
  }
  const details = failures.length ? failures.join(" ") : "The catalog returned no supported mirrors.";
  throw new Error(`LibGen listed the book but no tested mirror served the file. ${details}`);
}
