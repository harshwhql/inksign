# InkSign React example

A complete signing ceremony running entirely in the browser.

```bash
npm install
npm run dev -w @inksign/example-react-basic
```

The access code is `4821`.

## What it shows

- A two page agreement generated at runtime with pdf-lib, so there is no binary in the repository.
- Fields placed by **anchor text** rather than coordinates, so they stay attached to the signature block.
- The access code gate, the electronic record disclosure, and signature adoption by drawing, typing or upload.
- A virtualized viewer with fit-to-width scaling and a field overlay.
- The hash-chained audit trail, printed and verified once signing finishes.

Nothing is sent anywhere. The identity adapter is the in-memory one, which is suitable for local development only: the expected code is present on the client, so anyone can read it. In production that check belongs on a server.
