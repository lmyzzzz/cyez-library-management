FROM nginxinc/nginx-unprivileged:1.28.0-bookworm@sha256:cd33960e98e93d4d63385790ff7f8f5bf2ca95184c581b7f42ae8aea1139fbfc
USER root
RUN mkdir -p /var/log/cyez && chown nginx:nginx /var/log/cyez
USER nginx
