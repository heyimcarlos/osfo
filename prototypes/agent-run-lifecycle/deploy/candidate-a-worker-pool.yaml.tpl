apiVersion: run.googleapis.com/v1
kind: WorkerPool
metadata:
  name: ${OSFO_AGENT_RUN_WORKER_POOL}
  labels:
    cloud.googleapis.com/location: ${OSFO_DEPLOY_REGION}
  annotations:
    run.googleapis.com/launch-stage: BETA
    run.googleapis.com/scalingMode: manual
    run.googleapis.com/manualInstanceCount: '${OSFO_AGENT_RUN_WORKER_INSTANCES}'
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/container-dependencies: '{"agent-run-worker":["cloud-sql-proxy"]}'
    spec:
      serviceAccountName: ${OSFO_RUNTIME_SERVICE_ACCOUNT}
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
      - name: agent-run-worker
        image: ${OSFO_RUNTIME_IMAGE}
        command:
        - /usr/local/bin/agent_run_worker
        env:
        - name: OSFO_DATABASE_URL
          value: '${OSFO_DATABASE_URL}'
        - name: OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE
          value: '${OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE}'
        - name: OSFO_AGENT_RUN_WORKER_ID
          value: candidate-a-worker
        - name: OSFO_AGENT_RUN_EMPTY_POLL_MILLISECONDS
          value: '500'
        - name: OSFO_AGENT_RUN_WORKER_CONCURRENCY
          value: '${OSFO_AGENT_RUN_WORKER_CONCURRENCY}'
        resources:
          limits:
            cpu: '1'
            memory: 512Mi
