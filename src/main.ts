import { waitForEvenAppBridge, TextContainerProperty, CreateStartUpPageContainer } from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: 'Hello from G2!',
  isEventCapture: 1,
})

const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [mainText],
}))
console.log('Page created:', result === 0 ? 'success' : 'failed')
