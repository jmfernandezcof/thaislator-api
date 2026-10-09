# Invitaciones beta de EurThai

## Objetivo

EurThai permite probar las funciones de IA mediante invitaciones individuales. El
acceso público sin invitación muestra la solicitud de plaza beta; introducir un email
no desbloquea automáticamente las herramientas.

Cada invitación:

- tiene un token aleatorio individual;
- se comparte como `https://eurthai.nomadprompters.es/#invite=<token>`;
- caduca a los 14 días por defecto;
- dispone de 30 créditos diarios por defecto;
- puede listarse y revocarse;
- se muestra en claro únicamente al crearla.

El backend no conserva el token: guarda su SHA-256 en
`/data/logs/invites.json`. El ledger está persistido mediante el volumen de logs del
contenedor y no forma parte del repositorio.

## Comando rápido

El wrapper versionado vive en:

```text
/var/www/eur-thai-backend/scripts/eurthaicreate.sh
```

Está disponible globalmente como:

```bash
eurthaicreate <nombre y apellidos>
```

Se admiten nombres con o sin comillas:

```bash
eurthaicreate Ana García López
eurthaicreate "Ana García López"
```

La salida contiene ID, caducidad, créditos diarios y el enlace completo. El comando
no guarda nombres fuera del alias operativo del ledger y no envía mensajes ni emails.

## Panel de administración

Para la gestión habitual existe un panel interactivo en modo texto:

```bash
eurthaiadmin
```

El menú permite dar de alta testers, listar invitaciones y consumo, revocar con
confirmación, consultar ayuda y salir. El panel versionado vive en
`scripts/eurthaiadmin.sh` y se instala como `/usr/local/bin/eurthaiadmin`.
Internamente usa la CLI del contenedor, pero el operador no necesita escribir ni
conocer comandos Docker.

## Comandos administrativos

```bash
# Crear manualmente: alias, días y créditos diarios
docker exec eur-thai-backend npm run invites -- create "Alias" 14 30

# Listar invitaciones y consumo
docker exec eur-thai-backend npm run invites -- list

# Revocar por ID
docker exec eur-thai-backend npm run invites -- revoke ID
```

## Cuotas

Valores predeterminados:

- traducción y verificación: 1 crédito;
- menú o imagen: 3 créditos;
- visión/cartel: 8 créditos;
- tester: 30 créditos diarios;
- límite global: 250 créditos diarios.

Las cuotas reducen el riesgo de consumo accidental de APIs. La invitación no evita el
límite global ni los rate limits del backend.

## Flujo técnico

1. `eurthaicreate` comprueba que `eur-thai-backend` existe y está activo.
2. Ejecuta dentro del contenedor `npm run invites -- create`.
3. `scripts/invites.js` genera el token y actualiza atómicamente el ledger.
4. El administrador envía al tester el enlace mostrado.
5. El frontend procesa `?invite=`, valida el acceso mediante
   `POST /api/invite/status`, lo guarda localmente y limpia la URL.
6. Las peticiones IA envían la invitación en `x-arti-invite`.

La consulta de estado usa POST y `no-store` para impedir que Cloudflare reutilice
entre testers respuestas de saldo cacheadas.

## Operación y seguridad

- No publicar tokens de invitación en Git, documentación o chats públicos.
- No copiar `logs/invites.json` a ubicaciones públicas.
- Revocar una invitación si el enlace se comparte por error.
- El acceso heredado `?beta=` y la cabecera `x-arti-beta` fueron retirados el 2026-07-18. Solo funcionan invitaciones individuales.

- No hace falta reconstruir ni reiniciar el backend para crear, listar o revocar.

## Diagnóstico

```bash
# Ayuda del wrapper
eurthaicreate --help

# Estado del contenedor
docker ps --filter name=eur-thai-backend

# Salud interna
docker exec eur-thai-backend wget -qO- http://localhost:3010/health
```

Si el wrapper indica que el contenedor no está activo, diagnosticar el servicio antes
de crear la invitación. No iniciar ni reconstruir producción automáticamente desde el
wrapper.
