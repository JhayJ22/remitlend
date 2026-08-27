# Deployment Guide

This guide describes how to deploy RemitLend using Docker Compose in a production environment.

## Prerequisites

Before deploying RemitLend, ensure the deployment host has:

* Docker Engine installed and running.
* Docker Compose v2 or newer.
* Access to the GitHub Container Registry (GHCR) if the images are private.
* The required production environment variables.
* The required production secrets.
* Sufficient CPU, memory, and disk space for PostgreSQL, Redis, the backend, and frontend services.

Verify Docker and Compose:

```bash
docker --version
docker compose version
```

## Environment Configuration

Production configuration is supplied through environment variables.

Create a production environment file outside version control if required by the deployment environment:

```bash
touch .env.production
chmod 600 .env.production
```

The following variables are required by `docker-compose.production.yml`:

```env
OWNER=your-github-owner
TAG=v1.0.0

POSTGRES_DB=remitlend
POSTGRES_USER=remitlend

PII_KEK_ID=your-kek-id
PII_KMS_ENDPOINT=your-kms-endpoint
PII_KEK_REGION=your-kms-region
```

Do not commit production environment files or credentials to the repository.

For the complete environment variable reference, see `docs/ENVIRONMENT.md`.

## Production Secrets

Production secrets must not be hardcoded in `docker-compose.production.yml` or committed to Git.

Create the secrets directory:

```bash
mkdir -p secrets
```

Generate a strong PostgreSQL password:

```bash
openssl rand -base64 48 > secrets/postgres_password.txt
```

Restrict access to the secret:

```bash
chmod 600 secrets/postgres_password.txt
```

The secret file must contain only the PostgreSQL password:

```text
generated-random-password
```

Do not use:

```text
POSTGRES_PASSWORD=generated-random-password
```

The `secrets/` directory must remain outside version control.

Verify that it is ignored:

```bash
git status --ignored
```

The repository should contain a safe example file if contributors need to understand the expected structure:

```text
secrets/postgres_password.txt.example
```

Example:

```text
REPLACE_WITH_A_RANDOM_PRODUCTION_PASSWORD
```

Never place real production secrets in the example file.

## Production Deployment

Before starting the production services, validate the Compose configuration:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  config
```

Pull the production images:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  pull
```

Start the services:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  up -d
```

The production deployment consists of:

* PostgreSQL for persistent application data.
* Redis for application caching/queueing.
* Backend API.
* Frontend application.

PostgreSQL and Redis are intentionally not exposed through host ports. They communicate with the backend through the internal Docker network.

Production images should use an explicit release tag or immutable image reference rather than a mutable `latest` or staging tag.

## Verifying the Deployment

Check the status of all services:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  ps
```

Services should report a healthy or running state according to their configured health checks.

Check the backend logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs --tail=100 backend
```

Check all service logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs --tail=100
```

If the application exposes health endpoints, verify them from the deployment host or through the configured frontend/reverse proxy.

## Viewing Logs

Follow backend logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs -f backend
```

Follow frontend logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs -f frontend
```

Follow database logs:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  logs -f db
```

Avoid logging or printing environment variables containing secrets.

## Updating the Deployment

Use an explicit production image tag when deploying a new release.

Update the `TAG` value in `.env.production`:

```env
TAG=v1.1.0
```

Validate the new configuration:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  config
```

Pull the new images:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  pull
```

Recreate the services:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  up -d
```

Verify the deployment after the update:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  ps
```

If the deployment fails, inspect the service logs before rolling back.

## Stopping the Deployment

To stop and remove the running containers:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  down
```

This does not remove named volumes by default, so PostgreSQL data remains available.

Do not use:

```bash
docker compose down -v
```

in production unless you intentionally want to delete the persistent volumes and understand the data-loss consequences.

## Backup and Recovery

PostgreSQL data is stored in the persistent `postgres_data` Docker volume.

Production deployments should have an external PostgreSQL backup strategy. Docker volumes alone should not be considered a complete backup solution.

Before performing destructive maintenance or migrations, ensure a recent database backup is available.

A PostgreSQL dump can be created with:

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.production.yml \
  exec -T db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > remitlend-backup.sql
```

Store production backups outside the application host and protect them according to the project's data-security requirements.

For recovery, restore the database using the appropriate PostgreSQL restore procedure after ensuring the target database is available.

## Production Security Practices

The production Compose configuration follows these principles:

* PostgreSQL is not publicly exposed.
* Redis is not publicly exposed.
* Production credentials are not hardcoded in the Compose file.
* Sensitive credentials are supplied through secrets.
* Production image tags are explicit and reproducible.
* Containers use restart policies.
* Containers have CPU and memory resource limits.
* Services use health checks where supported.
* Containers use `no-new-privileges` where supported.
* Persistent application data is stored in named volumes.
* Production environment files and secrets must not be committed to Git.

Always review `docs/ENVIRONMENT.md` when adding or changing environment variables.
