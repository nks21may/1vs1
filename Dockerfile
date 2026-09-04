# syntax=docker/dockerfile:1

# NEONDUEL en dos etapas: la primera compila el monorepo entero, la segunda se
# queda solo con lo necesario para servir el juego.
#
# La imagen final no contiene ningun binario nativo: el servidor es un bundle de
# esbuild y su unica dependencia externa, `ws`, es JavaScript puro. Por eso la
# etapa de ejecucion puede ser Alpine aunque la compilacion ocurra en Debian.
#
# Se construye igual en x86_64 y en ARM64 (el Ampere A1 de Oracle Cloud): las
# variantes nativas de esbuild y de rollup para ambas arquitecturas estan
# fijadas en package-lock.json y `npm ci` instala la que corresponde.

FROM node:22-slim AS build
WORKDIR /app

# Las dependencias se instalan antes de copiar el codigo: mientras el lockfile
# no cambie, Docker reutiliza esta capa y recompilar cuesta segundos.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# El servidor busca el cliente en `../../client/dist` a partir de su propio
# archivo (server.ts), asi que el arbol de la imagen replica el del repositorio.
# Si alguna de estas dos rutas cambia, el juego arranca pero responde 404.
COPY --from=build /app/apps/server/dist/ apps/server/dist/
COPY --from=build /app/apps/client/dist/ apps/client/dist/

# `ws` es lo unico que esbuild deja fuera del bundle, y no arrastra ninguna otra
# dependencia; se copia tal cual para no repetir una instalacion completa.
COPY --from=build /app/node_modules/ws/ node_modules/ws/

USER node
EXPOSE 8080

# El propio endpoint de salud del juego: informa de las sesiones vivas y de la
# version del protocolo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD \
  node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/server.js"]
