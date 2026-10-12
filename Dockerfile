FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css app.js voice.js sw.js manifest.webmanifest /usr/share/nginx/html/
COPY icons /usr/share/nginx/html/icons
EXPOSE 80
