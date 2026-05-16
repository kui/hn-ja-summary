FROM denoland/deno:2.7.14

WORKDIR /app

COPY shared/ ./shared/
COPY poller/ ./poller/

RUN deno cache poller/main.ts

CMD ["deno", "run", "--allow-net", "--allow-env", "--no-prompt", "poller/main.ts"]
