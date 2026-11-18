# LibGen to Kindle MCP

A local MCP server that searches the [libgen.xyz catalog](https://libgen.xyz/), saves EPUBs and PDFs, and can email a selected edition to your Kindle. Use it for works you have permission to download.

## Install

Install Node.js 22 or later, then clone the repository and install its dependencies.

```sh
git clone https://github.com/MadanChaollaPark/libgen-kindle-mcp.git
cd libgen-kindle-mcp
npm ci --omit=dev
```

Register the server in an MCP client that supports local stdio. Use the absolute path to `server.mjs` and, if your MCP client cannot find Node on its PATH, the absolute path from `command -v node`.

```json
{
  "mcpServers": {
    "libgen-kindle": {
      "command": "node",
      "args": ["/absolute/path/to/libgen-kindle-mcp/server.mjs"]
    }
  }
}
```

## Set up Kindle delivery

1. In Amazon's Personal Document Settings, find your Send to Kindle email address and add your sender address to the Approved Personal Document Email List. [Amazon's approval instructions](https://digprjsurvey.amazon.com/csad/help/node/GX9XLEVV8G4DB28H).
2. Run `cp .env.example .env`. Set `KINDLE_EMAIL`, then add your mail provider's SMTP host, port, username and password. Use a provider-issued app password when your provider requires one. Set `SMTP_FROM` if the SMTP username differs from the approved sender address.
3. Restart the MCP client after editing the configuration. Keep `.env` private.

Port 587 uses STARTTLS. Port 465 uses implicit TLS. The server accepts a single configured Kindle recipient and handles one attachment per send. Amazon allows up to 50 MB by email. The server defaults to 18 MB of raw attachment data to accommodate typical mail limits and encoding overhead. [Amazon's email delivery instructions](https://digprjsurvey.amazon.com/csad/help/node/G7NECT4B4ZWHQ8WV).

## Use it

| Tool | What it does |
| --- | --- |
| `search_books` | Finds EPUB and PDF editions by title, author or ISBN. Returns edition IDs, language, format and file size when listed. |
| `download_book` | Fetches an edition and saves it under `downloads/` by default. Returns its local file path. |
| `send_to_kindle` | Fetches an edition and sends it as an email attachment. Returns an SMTP acceptance status. |

Try asking your agent to “Find *Pride and Prejudice* by Jane Austen in English EPUB and show me the editions,” then “Send the selected edition to my Kindle.”

If a LibGen mirror cannot serve the book, you can supply a known Project Gutenberg ID to either download or send. For example, “Send Project Gutenberg edition `gutenberg:1342` to my Kindle.” Those IDs come from the [Project Gutenberg book pages](https://www.gutenberg.org/ebooks/1342). The server looks up the edition in the catalog or [Gutendex](https://gutendex.com/) and accepts EPUBs marked public domain in the United States.

If your email provider rejects an attachment that you have saved locally, upload the file at [Send to Kindle for Web](https://www.amazon.com/sendtokindle). If SMTP accepted the email and the book hasn't appeared, check your sender inbox for an Amazon approval request or rejection before resending. [Amazon's troubleshooting guide](https://digprjsurvey.amazon.com/csad/help/node/T48rsVm3gY7KeGkKUk).

## Verification status

Live LibGen catalog search worked during testing. The LibGen mirrors tested for the sample editions returned a web page instead of an ebook. Project Gutenberg and the email attachment workflow were tested separately with a local SMTP receiver. Delivery to a live Kindle needs your approved sender and Kindle email address.
