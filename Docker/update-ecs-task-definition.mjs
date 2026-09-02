import fs from 'node:fs'

const [inputPath, outputPath, containerName, imageUri] = process.argv.slice(2)
if (!inputPath || !outputPath || !containerName || !imageUri) {
  console.error('usage: update-ecs-task-definition.mjs INPUT OUTPUT CONTAINER IMAGE')
  process.exit(2)
}

const task = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const containers = Array.isArray(task.containerDefinitions) ? task.containerDefinitions : []
const target = containers.find((container) => container.name === containerName)
if (!target) {
  console.error(`ECS container not found: ${containerName}`)
  console.error(`available containers: ${containers.map((container) => container.name).join(', ')}`)
  process.exit(1)
}
target.image = imageUri

for (const key of [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
]) {
  delete task[key]
}

fs.writeFileSync(outputPath, `${JSON.stringify(task, null, 2)}\n`)
