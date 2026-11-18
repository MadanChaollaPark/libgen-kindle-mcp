import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { configureKindle, sendBook } from "./kindle.mjs";
import { fetchBook, formats, searchBooks } from "./libgen.mjs";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url));
try {
  loadEnvFile(resolve(projectDirectory, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const downloadDirectory = resolve(projectDirectory, process.env.BOOK_DOWNLOAD_DIR || "downloads");
const bookId = z.string().regex(/^(gutenberg:)?\d{1,12}$/)
  .describe("Exact edition ID returned by search_books, or gutenberg:<ID> for a known Project Gutenberg edition.");

function result(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(error) {
  let message = "The operation failed. Check the source or local configuration.";
  if (error.name === "TimeoutError") message = "The source timed out. Try again later or choose another edition.";
  if (error.name === "AbortError") message = "The request was cancelled.";
  if (error.constructor === Error) message = error.message;
  return { content: [{ type: "text", text: message }], isError: true };
}

function fileName(book) {
  const title = book.title.normalize("NFC")
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return `${book.book_id.replace(":", "-")}-${[...(title || "book")].slice(0, 48).join("")}.${book.format}`;
}

serveStdio(() => {
  const server = new McpServer({ name: "libgen-kindle", version: "0.1.0" });
  const pendingSends = new Set();

  server.registerTool("search_books", {
    description: "Search the libgen.xyz catalog by title, author, or ISBN for EPUB and PDF editions.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({
      query: z.string().trim().min(2).max(200),
      collection: z.enum(["all", "fiction", "libgen"]).default("all"),
      format: z.enum(formats).optional(),
      limit: z.number().int().min(1).max(25).default(10),
    }),
  }, async (input, context) => {
    try {
      return result(await searchBooks(input, context.mcpReq.signal));
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("download_book", {
    description: "Save a selected LibGen EPUB or PDF or a known Project Gutenberg EPUB to the local downloads directory. Return its file path.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({ book_id: bookId }),
  }, async ({ book_id }, context) => {
    try {
      const { book, content } = await fetchBook(book_id, undefined, context.mcpReq.signal);
      const filename = fileName(book);
      const path = resolve(downloadDirectory, filename);
      const temp = resolve(downloadDirectory, `.${randomUUID()}.part`);
      await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(temp, content, { flag: "wx", mode: 0o600 });
        context.mcpReq.signal.throwIfAborted();
        await link(temp, path);
      } catch (error) {
        if (error.code === "EEXIST") return result({ status: "already_exists", book_id, path });
        throw error;
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
      return result({ ...book, path, bytes: content.length });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("send_to_kindle", {
    description: "Download a selected LibGen EPUB or PDF or known Project Gutenberg EPUB and submit it to the preconfigured Kindle address by email. Call only when the user requests Kindle delivery. If edition or language is ambiguous, ask which one before sending. A successful result means the SMTP server accepted it.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({ book_id: bookId }),
  }, async ({ book_id }, context) => {
    if (pendingSends.has(book_id)) return toolError(new Error("A send for this edition is already in progress."));
    pendingSends.add(book_id);
    try {
      const kindle = configureKindle();
      const file = await fetchBook(book_id, kindle.maxBytes, context.mcpReq.signal);
      context.mcpReq.signal.throwIfAborted();
      const receipt = await sendBook(kindle, { ...file, filename: fileName(file.book) });
      return result({ ...receipt, book_id, title: file.book.title });
    } catch (error) {
      return toolError(error);
    } finally {
      pendingSends.delete(book_id);
    }
  });
  return server;
});
