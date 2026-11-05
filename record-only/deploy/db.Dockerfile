FROM postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3
LABEL org.opencontainers.image.source="https://github.com/lmyzzzz/cyez-library-management"
RUN mkdir -p /var/log/cyez && chown postgres:postgres /var/log/cyez /var/lib/postgresql/data
USER postgres
