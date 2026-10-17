A signed identity document shaped like IMDS's `rsa2048` output: OpenSSL streaming CMS (`openssl cms -sign
-binary -nodetach -stream -md sha256`), so BER with indefinite lengths and the document inside a
constructed OCTET STRING, base64 wrapped at 64 columns. `signer.pem` is a throwaway self-signed test
certificate, not AWS's.
