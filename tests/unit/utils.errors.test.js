const { NotFoundError, ValidationError, BadRequestError } = require('../../utils/errors')
const logger = require('../../utils/logger')

describe('utils/errors', () => {
  it('constructs typed errors', () => {
    expect(new NotFoundError('x').name).toBe('NotFoundError')
    expect(new ValidationError('v').name).toBe('ValidationError')
    expect(new BadRequestError('b').name).toBe('BadRequestError')
  })
})

describe('utils/logger', () => {
  it('writes to console channels', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
    await logger.error('e', { a: 1 })
    await logger.warn('w', {})
    await logger.info('i', {})
    expect(console.error).toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
    expect(console.log).toHaveBeenCalled()
    jest.restoreAllMocks()
  })
})
