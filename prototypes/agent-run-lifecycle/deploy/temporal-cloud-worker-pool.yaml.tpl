apiVersion: run.googleapis.com/v1
kind: WorkerPool
metadata:
  name: ${OSFO_TEMPORAL_WORKER_POOL}
  labels:
    cloud.googleapis.com/location: ${OSFO_DEPLOY_REGION}
  annotations:
    run.googleapis.com/launch-stage: BETA
    run.googleapis.com/scalingMode: manual
    run.googleapis.com/manualInstanceCount: '${OSFO_TEMPORAL_WORKER_INSTANCES}'
spec:
  template:
    spec:
      serviceAccountName: ${OSFO_RUNTIME_SERVICE_ACCOUNT}
      containers:
      - name: temporal-cloud-worker
        image: ${OSFO_TEMPORAL_WORKER_IMAGE}
        env:
        - name: TEMPORAL_ADDRESS
          value: '${TEMPORAL_ADDRESS}'
        - name: TEMPORAL_NAMESPACE
          value: '${TEMPORAL_NAMESPACE}'
        - name: TEMPORAL_TASK_QUEUE
          value: '${TEMPORAL_TASK_QUEUE}'
        - name: TEMPORAL_API_KEY
          valueFrom:
            secretKeyRef:
              name: ${OSFO_TEMPORAL_API_KEY_SECRET_NAME}
              key: '${OSFO_TEMPORAL_API_KEY_SECRET_VERSION}'
        - name: OSFO_TEMPORAL_WORKER_FLEET_ID
          value: '${OSFO_TEMPORAL_WORKER_FLEET_ID}'
        - name: OSFO_TEMPORAL_WORKER_SLOTS
          value: '${OSFO_TEMPORAL_WORKER_SLOTS}'
        - name: OSFO_TEMPORAL_METRICS_ADDRESS
          value: 0.0.0.0:9465
        - name: OSFO_SANDBOX_PROVIDER
          value: disabled
        resources:
          limits:
            cpu: '2'
            memory: 2Gi
        startupProbe:
          tcpSocket:
            port: 9465
          initialDelaySeconds: 1
          timeoutSeconds: 1
          periodSeconds: 2
          failureThreshold: 30
