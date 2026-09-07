# Desplegar NEONDUEL en una VPS ARM de Oracle Cloud

El juego entero es **un contenedor y un puerto**: el mismo proceso sirve los
archivos del cliente y el WebSocket, así que no hay base de datos, ni cachés, ni
servicios que coordinar. Por defecto escucha solo en `127.0.0.1:8090`, para que
lo publique lo que ya tengas delante.

- [1. La instancia](#1-la-instancia)
- [2. Preparar la máquina](#2-preparar-la-máquina)
- [3. Levantar el juego](#3-levantar-el-juego)
- [4. Publicarlo con un túnel de Cloudflare](#4-publicarlo-con-un-túnel-de-cloudflare)
  - [Si prefieres pasar por nginx](#si-prefieres-pasar-por-nginx)
- [5. Publicarlo sin túnel](#5-publicarlo-sin-túnel)
- [Mantenimiento](#mantenimiento)
- [Cuando algo no responde](#cuando-algo-no-responde)

---

## 1. La instancia

En **Compute → Instances → Create instance**:

| Campo          | Valor                                                          |
| -------------- | -------------------------------------------------------------- |
| Shape          | `VM.Standard.A1.Flex` (Ampere, ARM)                            |
| OCPU / memoria | 1 OCPU y 6 GB bastan; con 2 OCPU la compilación tarda la mitad |
| Imagen         | Ubuntu 24.04 (**aarch64**)                                     |
| Claves SSH     | sube tu clave pública                                          |

El _always free_ cubre hasta 4 OCPU y 24 GB repartidos entre instancias A1. Este
juego no aprovecha más de un núcleo —es un único proceso con un bucle a 64 Hz—,
así que lo que sobre es mejor dejarlo libre para otra cosa.

## 2. Preparar la máquina

```bash
sudo apt-get update && sudo apt-get install -y git
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Sal y vuelve a entrar por SSH para que el grupo `docker` tenga efecto. El script
oficial trae imágenes para ARM64 y deja el servicio habilitado en el arranque,
así que tras un reinicio de la máquina el juego vuelve solo.

## 3. Levantar el juego

```bash
git clone https://github.com/nks21may/1vs1.git neonduel
cd neonduel
docker compose up -d --build
curl -s localhost:8090/health     # {"ok":true,"sessions":0,"version":4}
```

> Si el repositorio es privado, o prefieres no darle acceso a la máquina, copia
> el código con `rsync -a --exclude node_modules --exclude dist . ubuntu@TU_IP:neonduel/`.
> También puedes construir la imagen en tu portátil y enviarla ya hecha, sin
> compilar nada en la VPS:
>
> ```bash
> docker buildx build --platform linux/arm64 -t neonduel:latest --load .
> docker save neonduel:latest | ssh ubuntu@TU_IP "docker load"
> ```

La primera compilación descarga las dependencias y ejecuta Vite y esbuild: unos
minutos con 1 OCPU. Las siguientes reutilizan la capa de `npm ci` mientras no
cambie `package-lock.json`.

Si el 8090 ya está ocupado, cámbialo con `PUBLISH=127.0.0.1:8099` en un `.env`.

## 4. Publicarlo con un túnel de Cloudflare

Es la vía más corta si ya tienes `cloudflared` corriendo: no hay que abrir ningún
puerto en la lista de seguridad de Oracle ni tocar el cortafuegos, porque el túnel
sale desde la máquina hacia Cloudflare y nadie entra de fuera.

1. Crea el registro DNS. El comando lo añade solo, como un `CNAME` al túnel
   (`UUID.cfargotunnel.com`, siempre con proxy activado; no es un `A` a la IP):

   ```bash
   cloudflared tunnel route dns vps neonduel.nicolasdalessandro.dev
   ```

   Si el nombre ya existía, añade `--overwrite-dns`.

2. Añade la regla en `/etc/cloudflared/config.yml`, **antes** del `http_status:404`
   final: las reglas se evalúan en orden y la última se lo traga todo.

   ```yaml
   - hostname: neonduel.nicolasdalessandro.dev
     service: http://127.0.0.1:8090

   - service: http_status:404
   ```

3. Comprueba y recarga:

   ```bash
   sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress validate
   sudo cloudflared --config /etc/cloudflared/config.yml tunnel ingress url \
     https://neonduel.nicolasdalessandro.dev     # debe salir la regla del 8090
   sudo systemctl restart cloudflared
   ```

   Si estás dentro por `ssh.nicolasdalessandro.dev`, el reinicio corta tu propia
   sesión: el túnel vuelve en un par de segundos y basta con reconectar.

Los WebSocket pasan por el túnel sin configuración adicional, y como la página se
sirve por `https://`, el cliente cambia a `wss://` por su cuenta. No hay ninguna
URL que tocar en el código.

Lo que sí conviene saber: el tráfico entra por un PoP de Cloudflare y baja por el
túnel, así que el trayecto es más largo que ir directo a la IP. En un shooter que
compensa la latencia rebobinando el mundo, eso se paga en forma de «me ha matado
desde detrás de la esquina». Si el ping molesta, la sección 5 es la alternativa.

### Si prefieres pasar por nginx

No hace falta —cloudflared llega igual de bien al contenedor—, pero si quieres
todo bajo el mismo sitio, el bloque tiene que dejar pasar la actualización a
WebSocket, que es justo lo que un `proxy_pass` de manual se come:

```nginx
# En el bloque http { }, una sola vez:
map $http_upgrade $connection_upgrade { default upgrade; "" close; }

server {
    listen 127.0.0.1:8081;
    server_name neonduel.nicolasdalessandro.dev;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # una partida dura mucho más que 60 s
        proxy_buffering off;        # el estado sale 64 veces por segundo
    }
}
```

Y en `config.yml`, el `service` pasa a ser `http://127.0.0.1:8081`.

## 5. Publicarlo sin túnel

Si prefieres la ruta directa —menos saltos y menos latencia, pero la IP queda a
la vista y el certificado corre de tu cuenta:

1. Levanta el juego escuchando hacia fuera: `PUBLISH=0.0.0.0:80` en el `.env`.
2. **Networking → Virtual Cloud Networks → tu VCN → Subnets → tu subred →
   Security Lists → Add Ingress Rules**: origen `0.0.0.0/0`, TCP, puerto 80.
3. En Cloudflare, un registro `A` a la IP pública. En **gris** (_DNS only_) el
   trayecto es directo; en naranja vuelves a tener el salto del PoP, y entonces
   el túnel es más cómodo.
4. Para HTTPS necesitas algo que termine el TLS: el nginx que ya tienes con
   `certbot`, o un certificado de origen de Cloudflare si vas en naranja.

Sin HTTPS el juego funciona igual, pero es un enlace que nadie se atreve a abrir.

## Mantenimiento

```bash
git pull && docker compose up -d --build   # actualizar (corta las partidas en curso)
docker compose logs -f --tail 100          # ver qué pasa
docker compose ps                          # estado y salud del contenedor
docker image prune -f                      # borrar las imágenes viejas
docker compose down                        # parar
```

El estado vive en memoria: al recrear el contenedor se cierran las partidas
abiertas y los jugadores tienen que volver a emparejarse. Como no hay nada que
persistir, tampoco hay copias de seguridad que hacer.

Consumo: una partida son unos 15 KB/s en cada sentido, así que el límite de
salida del _always free_ (10 TB al mes) no se acerca ni jugando sin parar. La
imagen ocupa ~230 MB y el proceso ronda los 80 MB de memoria.

## Cuando algo no responde

| Síntoma                                       | Causa habitual                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `curl localhost:8090/health` falla            | El contenedor no arrancó: `docker compose logs`                          |
| Error 1033 de Cloudflare                      | `cloudflared` no está conectado: `systemctl status cloudflared`          |
| 502 desde el túnel                            | El `service:` del `config.yml` apunta a un puerto donde no hay nada      |
| Sale el 404 del túnel                         | La regla quedó detrás del `http_status:404`, o el hostname no coincide   |
| Carga la página pero se queda en «conectando» | Algo en medio no deja pasar la actualización a WebSocket (mira el nginx) |
| «Versión de protocolo incompatible»           | Cliente y servidor de compilaciones distintas; recompila la imagen       |

Si expones el puerto directamente y no responde desde fuera, además de la regla
de la lista de seguridad está el cortafuegos local: la imagen de Ubuntu de Oracle
trae reglas de `iptables` que rechazan casi todo. Los puertos que publica Docker
no suelen verse afectados —el tráfico redirigido pasa por la cadena `FORWARD`, no
por `INPUT`—, pero si no hay manera, ábrelos a mano por delante del `REJECT`:

```bash
sudo iptables -L INPUT --line-numbers        # localiza la línea del REJECT
sudo iptables -I INPUT 6 -p tcp --dport 80 -m state --state NEW -j ACCEPT
sudo netfilter-persistent save               # sin esto se pierden al reiniciar
```
