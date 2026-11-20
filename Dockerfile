FROM node:22-alpine

WORKDIR /app

# Ensure data directory exists
RUN mkdir -p /app/data

# Copy server, assets, configurations, and standalone client executables
COPY admin/ /app/admin/
COPY config.default.json /app/config.default.json
COPY vserve-timechamp-setup.exe /app/vserve-timechamp-setup.exe
COPY vserve-timechamp-uninstall.exe /app/vserve-timechamp-uninstall.exe

ENV NODE_ENV=production
ENV PORT=3000
ENV LOCAL_DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "admin/server.js"]
