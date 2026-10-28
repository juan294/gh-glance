This certificate and private key are synthetic localhost-only TLS test fixtures.
They authorize no account or external service. The offline CI qualifier supplies
the certificate only to its injected external HTTPS request seam. Production
uses normal certificate validation and has no test-CA or endpoint setting.
