These certificates and `server.key` are deliberately public, disposable TLS test fixtures.
The private key is used only by a test listener on the local loopback interface. Never use these
files for a deployed service or as a trusted production CA.

`server.crt` is a self-signed test CA used by the listener; `unrelated.crt` is a different test CA.
`leaf.crt` has `CA:FALSE` and verifies that configuration rejects a leaf as a trust anchor.
The certificates use reserved `.invalid` names. Tests connect with a different proxy hostname to
exercise explicit private CA trust and the default hostname check.
