const nock = require('nock')
const route = require('nock-knock/lib').default
const { Probot, Octokit } = require('probot')
const getConfigMock = require('./helpers/config-mock')
const releaseDrafter = require('../index')

nock.disableNetConnect()

const cert = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC2RTg7dNjQMwPzFwF0gXFRCcRHha4H24PeK7ey6Ij39ay1hy2o
H9NEZOxrmAb0bEBDuECImTsJdpgI6F3OwkJGsOkIH09xTk5tC4fkfY8N7LklK+uM
ndN4+VUXTPSj/U8lQtCd9JnnUL/wXDc46wRJ0AAKsQtUw5n4e44f+aYggwIDAQAB
AoGAW2/cJs+WWNPO3msjGrw5CYtZwPuJ830m6RSLYiAPXj0LuEEpIVdd18i9Zbht
fL61eoN7NEuSd0vcN1PCg4+mSRAb/LoauSO3HXote+6Lhg+y5mVYTNkE0ZAW1zUb
HOelQp9M6Ia/iQFIMykhrNLqMG9xQIdLH8BDGuqTE+Eh8jkCQQDyR6qfowD64H09
oYJI+QbsE7yDOnG68tG7g9h68Mp089YuQ43lktz0q3fhC7BhBuSnfkBHwMztABuA
Ow1+dP9FAkEAwJeYJYxJN9ron24IePDoZkL0T0faIWIX2htZH7kJODs14OP+YMVO
1CPShdTIgFeVp/HlAY2Qqk/do2fzyueZJwJBAN5GvdUjmRyRpJVMfdkxDxa7rLHA
huL7L0wX1B5Gl5fgtVlQhPhgWvLl9V+0d6csyc6Y16R80AWHmbN1ehXQhPkCQGfF
RsV0gT8HRLAiqY4AwDfZe6n8HRw/rnpmoe7l1IHn5W/3aOjbZ04Gvzg9HouIpaqI
O8xKathZkCKrsEBz6aECQQCLgqOCJz4MGIVHP4vQHgYp8YNZ+RMSfJfZA9AyAsgP
Pc6zWtW2XuNIGHw9pDj7v1yDolm7feBXLg8/u9APwHDy
-----END RSA PRIVATE KEY-----`

describe('release-drafter', () => {
  let probot

  beforeEach(() => {
    probot = new Probot({ id: 179208, cert, Octokit })
    probot.load(releaseDrafter)

    nock('https://api.github.com')
      .post('/app/installations/179208/access_tokens')
      .reply(200, { token: 'test' })

    // We have to delete all the GITHUB_* envs before every test, because if
    // we're running the tests themselves inside a GitHub Actions container
    // they'll mess with the tests, and also because we set some of them in
    // tests and we don't want them to leak into other tests.
    Object.keys(process.env)
      .filter(key => key.match(/^GITHUB_/))
      .forEach(key => {
        delete process.env[key]
      })
  })

  afterAll(nock.restore)
  afterEach(nock.cleanAll)

  describe('push', () => {
    describe('without a config', () => {
      it('does nothing', async () => {
        nock('https://api.github.com')
          .get(
            '/repos/toolmantim/release-drafter-test-project/contents/.github/release-drafter.yml'
          )
          .reply(404)
          .get('/repos/toolmantim/.github/contents/.github/release-drafter.yml')
          .reply(404)

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push')
        })
      })
    })

    describe('to a non-master branch', () => {
      it('does nothing', async () => {
        getConfigMock()

        nock('https://api.github.com')
          .post(route('/repos/:owner/:repo/releases'))
          .reply(200, () => {
            throw new Error("Shouldn't create a new release")
          })
          .patch(route('/repos/:owner/:repo/releases/:release_id'))
          .reply(200, () => {
            throw new Error("Shouldn't update an existing release")
          })

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push-non-master-branch')
        })
      })

      describe('when configured for that branch', () => {
        it('creates a release draft', async () => {
          getConfigMock('config-non-master-branch.yml')

          nock('https://api.github.com')
            .post('/graphql', body =>
              body.query.includes('query findCommitsWithAssociatedPullRequests')
            )
            .reply(200, require('./fixtures/graphql-commits-no-prs.json'))

          nock('https://api.github.com')
            .get('/repos/toolmantim/release-drafter-test-project/releases')
            .query(true)
            .reply(200, [require('./fixtures/release')])
            .post(
              '/repos/toolmantim/release-drafter-test-project/releases',
              body => {
                expect(body).toMatchObject({
                  name: '',
                  tag_name: '',
                  body: `# What's Changed\n\n* No changes\n`,
                  draft: true
                })
                return true
              }
            )
            .reply(200)

          await probot.receive({
            name: 'push',
            payload: require('./fixtures/push-non-master-branch')
          })
        })
      })
    })

    describe('with no past releases', () => {
      it('sets $CHANGES based on all commits, and $PREVIOUS_TAG to blank', async () => {
        getConfigMock('config-previous-tag.yml')

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .get(
            '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
          )
          .reply(200, [])

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `Changes:
* Add documentation (#5) @TimonVS
* Update dependencies (#4) @TimonVS
* Bug fixes (#3) @TimonVS
* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS

Previous tag: ''
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        const payload = require('./fixtures/push')

        await probot.receive({
          name: 'push',
          payload
        })

        expect.assertions(1)
      })
    })

    describe('with past releases', () => {
      it('creates a new draft listing the changes', async () => {
        getConfigMock()

        nock('https://api.github.com')
          .get(
            '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
          )
          .reply(200, [
            require('./fixtures/release-2'),
            require('./fixtures/release'),
            require('./fixtures/release-3')
          ])

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Add documentation (#5) @TimonVS
* Update dependencies (#4) @TimonVS
* Bug fixes (#3) @TimonVS
* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push')
        })

        expect.assertions(1)
      })

      it('creates a new draft when run as a GitHub Actiin', async () => {
        getConfigMock()

        // GitHub actions should use the GITHUB_REF and not the payload ref
        process.env['GITHUB_REF'] = 'refs/heads/master'

        nock('https://api.github.com')
          .get(
            '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
          )
          .reply(200, [
            require('./fixtures/release-2'),
            require('./fixtures/release'),
            require('./fixtures/release-3')
          ])

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Add documentation (#5) @TimonVS
* Update dependencies (#4) @TimonVS
* Bug fixes (#3) @TimonVS
* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        await probot.receive({
          name: 'push',
          // This payload has a different ref to GITHUB_REF, which is how GitHub
          // Action merge push payloads behave
          payload: require('./fixtures/push-non-master-branch')
        })

        expect.assertions(1)
      })

      describe('with custom changes-template config', () => {
        it('creates a new draft using the template', async () => {
          getConfigMock('config-with-changes-templates.yml')

          nock('https://api.github.com')
            .get(
              '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
            )
            .reply(200, [require('./fixtures/release')])

          nock('https://api.github.com')
            .post('/graphql', body =>
              body.query.includes('query findCommitsWithAssociatedPullRequests')
            )
            .reply(
              200,
              require('./fixtures/__generated__/graphql-commits-merge-commit.json')
            )

          nock('https://api.github.com')
            .post(
              '/repos/toolmantim/release-drafter-test-project/releases',
              body => {
                expect(body).toMatchObject({
                  body: `* Change: #5 'Add documentation' @TimonVS
* Change: #4 'Update dependencies' @TimonVS
* Change: #3 'Bug fixes' @TimonVS
* Change: #2 'Add big feature' @TimonVS
* Change: #1 '👽 Add alien technology' @TimonVS`,
                  draft: true,
                  tag_name: ''
                })
                return true
              }
            )
            .reply(200)

          await probot.receive({
            name: 'push',
            payload: require('./fixtures/push')
          })

          expect.assertions(1)
        })
      })

      describe('with contributors config', () => {
        it('adds the contributors', async () => {
          getConfigMock('config-with-contributors.yml')

          nock('https://api.github.com')
            .get(
              '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
            )
            .reply(200, [require('./fixtures/release')])

          nock('https://api.github.com')
            .post('/graphql', body =>
              body.query.includes('query findCommitsWithAssociatedPullRequests')
            )
            .reply(
              200,
              require('./fixtures/__generated__/graphql-commits-merge-commit.json')
            )

          nock('https://api.github.com')
            .post(
              '/repos/toolmantim/release-drafter-test-project/releases',
              body => {
                expect(body).toMatchObject({
                  body: `A big thanks to: @TimonVS and Ada Lovelace`,
                  draft: true,
                  tag_name: ''
                })
                return true
              }
            )
            .reply(200)

          await probot.receive({
            name: 'push',
            payload: require('./fixtures/push')
          })

          expect.assertions(1)
        })
      })
    })

    describe('with no changes since the last release', () => {
      it('creates a new draft with no changes', async () => {
        getConfigMock()

        nock('https://api.github.com')
          .get(
            '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
          )
          .reply(200, [
            require('./fixtures/release-2'),
            require('./fixtures/release'),
            require('./fixtures/release-3')
          ])

        nock('https://api.github.com')
          .post('/graphql', body => {
            expect(body.variables.since).toBe(
              require('./fixtures/release-3').published_at
            )
            return body.query.includes(
              'query findCommitsWithAssociatedPullRequests'
            )
          })
          .reply(200, require('./fixtures/graphql-commits-empty.json'))

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* No changes
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push')
        })

        expect.assertions(2)
      })

      describe('with custom no-changes-template config', () => {
        it('creates a new draft with the template', async () => {
          getConfigMock('config-with-changes-templates.yml')

          nock('https://api.github.com')
            .get('/repos/toolmantim/release-drafter-test-project/releases')
            .query(true)
            .reply(200, [])

          nock('https://api.github.com')
            .post('/graphql', body =>
              body.query.includes('query findCommitsWithAssociatedPullRequests')
            )
            .reply(200, require('./fixtures/graphql-commits-empty.json'))

          nock('https://api.github.com')
            .post(
              '/repos/toolmantim/release-drafter-test-project/releases',
              body => {
                expect(body).toMatchObject({
                  body: `* No changes mmkay`,
                  draft: true,
                  tag_name: ''
                })
                return true
              }
            )
            .reply(200)

          await probot.receive({
            name: 'push',
            payload: require('./fixtures/push')
          })

          expect.assertions(1)
        })
      })
    })

    describe('with an existing draft release', () => {
      it('updates the existing release’s body', async () => {
        getConfigMock()

        nock('https://api.github.com')
          .get('/repos/toolmantim/release-drafter-test-project/releases')
          .query(true)
          .reply(200, [require('./fixtures/release-draft.json')])

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .patch(
            '/repos/toolmantim/release-drafter-test-project/releases/11691725',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Add documentation (#5) @TimonVS
* Update dependencies (#4) @TimonVS
* Bug fixes (#3) @TimonVS
* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS
`
              })
              return true
            }
          )
          .reply(200)

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push')
        })

        expect.assertions(1)
      })
    })

    describe('with categories config', () => {
      it('categorizes pull requests with single label', async () => {
        getConfigMock('config-with-categories.yml')

        nock('https://api.github.com')
          .get('/repos/toolmantim/release-drafter-test-project/releases')
          .query(true)
          .reply(200, [require('./fixtures/release')])

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Add documentation (#5) @TimonVS
* Update dependencies (#4) @TimonVS

## 🚀 Features

* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS

## 🐛 Bug Fixes

* Bug fixes (#3) @TimonVS
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push')
        })

        expect.assertions(1)
      })

      it('categorizes pull requests with multiple labels', async () => {
        getConfigMock('config-with-categories-2.yml')

        nock('https://api.github.com')
          .get('/repos/toolmantim/release-drafter-test-project/releases')
          .query(true)
          .reply(200, [require('./fixtures/release')])

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Add documentation (#5) @TimonVS
* Update dependencies (#4) @TimonVS

## 🚀 Features

* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS

## 🐛 Bug Fixes

* Bug fixes (#3) @TimonVS
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push')
        })

        expect.assertions(1)
      })
    })

    describe('with exclude-labels config', () => {
      it('excludes pull requests', async () => {
        getConfigMock('config-with-exclude-labels.yml')

        nock('https://api.github.com')
          .get('/repos/toolmantim/release-drafter-test-project/releases')
          .query(true)
          .reply(200, [require('./fixtures/release')])

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Update dependencies (#4) @TimonVS

## 🚀 Features

* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS

## 🐛 Bug Fixes

* Bug fixes (#3) @TimonVS
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        await probot.receive({
          name: 'push',
          payload: require('./fixtures/push')
        })

        expect.assertions(1)
      })
    })
    describe('merging strategies', () => {
      describe('merge commit', () => {
        it('sets $CHANGES based on all commits', async () => {
          getConfigMock()

          nock('https://api.github.com')
            .post('/graphql', body =>
              body.query.includes('query findCommitsWithAssociatedPullRequests')
            )
            .reply(
              200,
              require('./fixtures/__generated__/graphql-commits-merge-commit.json')
            )

          nock('https://api.github.com')
            .get(
              '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
            )
            .reply(200, [])

          nock('https://api.github.com')
            .post(
              '/repos/toolmantim/release-drafter-test-project/releases',
              body => {
                expect(body).toMatchObject({
                  body: `# What's Changed

* Add documentation (#5) @TimonVS
* Update dependencies (#4) @TimonVS
* Bug fixes (#3) @TimonVS
* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS
`,
                  draft: true,
                  tag_name: ''
                })
                return true
              }
            )
            .reply(200)

          const payload = require('./fixtures/push')

          await probot.receive({
            name: 'push',
            payload
          })

          expect.assertions(1)
        })
      })

      describe('rebase merging', () => {
        it('sets $CHANGES based on all commits', async () => {
          getConfigMock()

          nock('https://api.github.com')
            .post('/graphql', body =>
              body.query.includes('query findCommitsWithAssociatedPullRequests')
            )
            .reply(
              200,
              require('./fixtures/__generated__/graphql-commits-rebase-merging.json')
            )

          nock('https://api.github.com')
            .get(
              '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
            )
            .reply(200, [])

          nock('https://api.github.com')
            .post(
              '/repos/toolmantim/release-drafter-test-project/releases',
              body => {
                expect(body).toMatchObject({
                  body: `# What's Changed

* Add documentation (#10) @TimonVS
* Update dependencies (#9) @TimonVS
* Bug fixes (#8) @TimonVS
* Add big feature (#7) @TimonVS
* 👽 Add alien technology (#6) @TimonVS
`,
                  draft: true,
                  tag_name: ''
                })
                return true
              }
            )
            .reply(200)

          const payload = require('./fixtures/push')

          await probot.receive({
            name: 'push',
            payload
          })

          expect.assertions(1)
        })
      })

      describe('squash merging', () => {
        it('sets $CHANGES based on all commits', async () => {
          getConfigMock()

          nock('https://api.github.com')
            .post('/graphql', body =>
              body.query.includes('query findCommitsWithAssociatedPullRequests')
            )
            .reply(
              200,
              require('./fixtures/__generated__/graphql-commits-squash-merging.json')
            )

          nock('https://api.github.com')
            .get(
              '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
            )
            .reply(200, [])

          nock('https://api.github.com')
            .post(
              '/repos/toolmantim/release-drafter-test-project/releases',
              body => {
                expect(body).toMatchObject({
                  body: `# What's Changed

* Add documentation (#15) @TimonVS
* Update dependencies (#14) @TimonVS
* Bug fixes (#13) @TimonVS
* Add big feature (#12) @TimonVS
* 👽 Add alien technology (#11) @TimonVS
`,
                  draft: true,
                  tag_name: ''
                })
                return true
              }
            )
            .reply(200)

          const payload = require('./fixtures/push')

          await probot.receive({
            name: 'push',
            payload
          })

          expect.assertions(1)
        })
      })
    })

    describe('pagination', () => {
      it('sets $CHANGES based on all commits', async () => {
        getConfigMock('config.yml')

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(200, require('./fixtures/graphql-commits-paginated-1.json'))
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(200, require('./fixtures/graphql-commits-paginated-2.json'))

        nock('https://api.github.com')
          .get(
            '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
          )
          .reply(200, [])

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Added great distance (#16) @toolmantim
* Oh hai (#15) @toolmantim
* ❤️ Add MOAR THINGS (#14) @toolmantim
* Add all the tests (#13) @toolmantim
* 🤖 Add robots (#12) @toolmantim
* 🎃 More pumpkins (#11) @toolmantim
* 🐄 Moar cowbell (#10) @toolmantim
* 1️⃣ Switch to a monorepo (#9) @toolmantim
* 👽 Integrate Alien technology (#8) @toolmantim
* Add ⛰ technology (#7) @toolmantim
* 👽 Added alien technology (#6) @toolmantim
* 🙅🏼‍♂️ 🐄 (#5) @toolmantim
* 🐄 More cowbell (#4) @toolmantim
* 🐒 Add monkeys technology (#3) @toolmantim
* Adds a new Widgets API (#2) @toolmantim
* Create new-feature.md (#1) @toolmantim
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        const payload = require('./fixtures/push')

        await probot.receive({
          name: 'push',
          payload
        })

        expect.assertions(1)
      })
    })

    describe('custom replacers', () => {
      it('replaces a string', async () => {
        getConfigMock('config-with-replacers.yml')

        nock('https://api.github.com')
          .post('/graphql', body =>
            body.query.includes('query findCommitsWithAssociatedPullRequests')
          )
          .reply(
            200,
            require('./fixtures/__generated__/graphql-commits-merge-commit.json')
          )

        nock('https://api.github.com')
          .get(
            '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
          )
          .reply(200, [])

        nock('https://api.github.com')
          .post(
            '/repos/toolmantim/release-drafter-test-project/releases',
            body => {
              expect(body).toMatchObject({
                body: `# What's Changed

* Add documentation (#1000) @TimonVS
* Update dependencies (#4) @TimonVS
* Bug fixes (#3) @TimonVS
* Add big feature (#2) @TimonVS
* 👽 Add alien technology (#1) @TimonVS
`,
                draft: true,
                tag_name: ''
              })
              return true
            }
          )
          .reply(200)

        const payload = require('./fixtures/push')

        await probot.receive({
          name: 'push',
          payload
        })

        expect.assertions(1)
      })
    })
  })

  describe('with sort-by config', () => {
    it('sorts by title', async () => {
      getConfigMock('config-with-sort-by-title.yml')

      nock('https://api.github.com')
        .post('/graphql', body =>
          body.query.includes('query findCommitsWithAssociatedPullRequests')
        )
        .reply(200, require('./fixtures/graphql-commits-paginated-1.json'))
        .post('/graphql', body =>
          body.query.includes('query findCommitsWithAssociatedPullRequests')
        )
        .reply(200, require('./fixtures/graphql-commits-paginated-2.json'))

      nock('https://api.github.com')
        .get(
          '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
        )
        .reply(200, [])

      nock('https://api.github.com')
        .post(
          '/repos/toolmantim/release-drafter-test-project/releases',
          body => {
            expect(body).toMatchObject({
              body: `# What's Changed

* 🤖 Add robots (#12) @toolmantim
* 🙅🏼‍♂️ 🐄 (#5) @toolmantim
* 👽 Integrate Alien technology (#8) @toolmantim
* 👽 Added alien technology (#6) @toolmantim
* 🐒 Add monkeys technology (#3) @toolmantim
* 🐄 More cowbell (#4) @toolmantim
* 🐄 Moar cowbell (#10) @toolmantim
* 🎃 More pumpkins (#11) @toolmantim
* ❤️ Add MOAR THINGS (#14) @toolmantim
* Oh hai (#15) @toolmantim
* Create new-feature.md (#1) @toolmantim
* Adds a new Widgets API (#2) @toolmantim
* Added great distance (#16) @toolmantim
* Add ⛰ technology (#7) @toolmantim
* Add all the tests (#13) @toolmantim
* 1️⃣ Switch to a monorepo (#9) @toolmantim
`,
              draft: true,
              tag_name: ''
            })
            return true
          }
        )
        .reply(200)

      const payload = require('./fixtures/push')

      await probot.receive({
        name: 'push',
        payload
      })

      expect.assertions(1)
    })
  })

  describe('with sort-direction config', () => {
    it('sorts ascending', async () => {
      getConfigMock('config-with-sort-direction-ascending.yml')

      nock('https://api.github.com')
        .post('/graphql', body =>
          body.query.includes('query findCommitsWithAssociatedPullRequests')
        )
        .reply(200, require('./fixtures/graphql-commits-paginated-1.json'))
        .post('/graphql', body =>
          body.query.includes('query findCommitsWithAssociatedPullRequests')
        )
        .reply(200, require('./fixtures/graphql-commits-paginated-2.json'))

      nock('https://api.github.com')
        .get(
          '/repos/toolmantim/release-drafter-test-project/releases?per_page=100'
        )
        .reply(200, [])

      nock('https://api.github.com')
        .post(
          '/repos/toolmantim/release-drafter-test-project/releases',
          body => {
            expect(body).toMatchObject({
              body: `# What's Changed

* Create new-feature.md (#1) @toolmantim
* Adds a new Widgets API (#2) @toolmantim
* 🐒 Add monkeys technology (#3) @toolmantim
* 🐄 More cowbell (#4) @toolmantim
* 🙅🏼‍♂️ 🐄 (#5) @toolmantim
* 👽 Added alien technology (#6) @toolmantim
* Add ⛰ technology (#7) @toolmantim
* 👽 Integrate Alien technology (#8) @toolmantim
* 1️⃣ Switch to a monorepo (#9) @toolmantim
* 🐄 Moar cowbell (#10) @toolmantim
* 🎃 More pumpkins (#11) @toolmantim
* 🤖 Add robots (#12) @toolmantim
* Add all the tests (#13) @toolmantim
* ❤️ Add MOAR THINGS (#14) @toolmantim
* Oh hai (#15) @toolmantim
* Added great distance (#16) @toolmantim
`,
              draft: true,
              tag_name: ''
            })
            return true
          }
        )
        .reply(200)

      const payload = require('./fixtures/push')

      await probot.receive({
        name: 'push',
        payload
      })

      expect.assertions(1)
    })
  })
})
