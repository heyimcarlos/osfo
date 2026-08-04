apiVersion: run.googleapis.com/v1
kind: WorkerPool
metadata:
  name: ${OSFO_SCHEMA_WORKER_POOL}
  labels:
    cloud.googleapis.com/location: ${OSFO_DEPLOY_REGION}
  annotations:
    run.googleapis.com/launch-stage: BETA
    run.googleapis.com/scalingMode: manual
    run.googleapis.com/manualInstanceCount: '1'
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/container-dependencies: '{"schema-command":["cloud-sql-proxy"]}'
    spec:
      serviceAccountName: ${OSFO_SCHEMA_SERVICE_ACCOUNT}
      containers:
      - name: cloud-sql-proxy
        image: ${OSFO_CLOUD_SQL_PROXY_IMAGE}
        args:
        - --auto-iam-authn
        - --structured-logs
        - --address=0.0.0.0
        - --port=5432
        - --health-check
        - --http-address=0.0.0.0
        - --http-port=9090
        - ${OSFO_CLOUD_SQL_CONNECTION_NAME}
        resources:
          limits:
            cpu: '0.25'
            memory: 256Mi
        startupProbe:
          httpGet:
            path: /startup
            port: 9090
          initialDelaySeconds: 1
          timeoutSeconds: 1
          periodSeconds: 1
          failureThreshold: 30
      - name: schema-command
        image: ${OSFO_RUNTIME_IMAGE}
        command:
        - /bin/sh
        args:
        - -c
        - '${OSFO_SCHEMA_COMMAND} && sleep infinity'
        env:
        - name: OSFO_DATABASE_URL
          value: '${OSFO_DATABASE_URL}'
        resources:
          limits:
            cpu: '1'
            memory: 512Mi
