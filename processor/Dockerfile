FROM denoland/deno:2.7.14

WORKDIR /app

COPY shared/ ./shared/
COPY processor/ ./processor/

RUN deno cache processor/main.ts

ENV PORT=8080
EXPOSE 8080

CMD ["deno", "run", "--allow-net", "--allow-env", "--no-prompt", "processor/main.ts"]
